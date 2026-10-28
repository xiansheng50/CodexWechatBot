import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DesktopClient, NativePipeClient, callerFromMetadata } from '../src/desktop-client.mjs';

async function endpoint(t, handle) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', b => {
      buffer = Buffer.concat([buffer, b]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const n = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, n + 4));
        buffer = buffer.subarray(n + 4);
        handle(request, socket);
      }
    });
  });
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\wechatbot-test-${randomUUID()}` : `/tmp/wechatbot-test-${randomUUID()}`;
  server.listen(path);
  await once(server, 'listening');
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); });
  return path;
}
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

test('caller identity comes only from per-call metadata, never inherited thread env', () => {
  assert.throws(() => callerFromMetadata({}), /trusted/);
  assert.throws(() => callerFromMetadata({ 'x-codex-turn-metadata': 'bad json' }), /trusted/);
  assert.deepEqual(callerFromMetadata({ 'openai/threadId': 'chat-A', 'openai/turnId': 'turn-A' }), { threadId: 'chat-A', turnId: 'turn-A' });
  assert.deepEqual(callerFromMetadata({ 'x-codex-turn-metadata': '{"thread_id":"chat-B","turn_id":"turn-B"}' }), { threadId: 'chat-B', turnId: 'turn-B' });
});

test('native framing handles fragmented/coalesced replies and concurrent request IDs', async t => {
  let first;
  const path = await endpoint(t, (r, socket) => {
    if (!first) { first = r; return; }
    const response = Buffer.concat([frame({ jsonrpc: '2.0', id: r.id, result: 'second' }), frame({ jsonrpc: '2.0', id: first.id, result: 'first' })]);
    socket.write(response.subarray(0, 2));
    setTimeout(() => socket.write(response.subarray(2)), 5);
  });
  const client = new NativePipeClient(path);
  t.after(() => client.close());
  assert.deepEqual(await Promise.all([client.request('a', {}), client.request('b', {})]), ['first', 'second']);
});

test('a dispatched timeout is unknown and is not resent', async t => {
  let calls = 0;
  const path = await endpoint(t, () => { calls++; });
  const client = new NativePipeClient(path, { timeoutMs: 50 });
  t.after(() => client.close());
  await assert.rejects(client.request('tools/call', {}), /outcome may be unknown/);
  assert.equal(calls, 1);
  assert.equal(client.pending.size, 0);
});

test('oversized frames close the transport and fail pending reads', async t => {
  const path = await endpoint(t, (r, socket) => { const header = Buffer.alloc(4); header.writeUInt32LE(8 * 1024 * 1024 + 1); socket.write(header); });
  const client = new NativePipeClient(path);
  t.after(() => client.close());
  await assert.rejects(client.request('read', {}), /frame/);
});

test('desktop writes preserve settings and carry distinct caller and target IDs', async () => {
  const client = new DesktopClient({ pipePath: 'unused', hostId: 'local', callerThreadId: 'source', callerTurnId: 'source-turn' });
  client.tools = new Map([['send_message_to_thread', { namespace: 'codex_app' }]]);
  let params;
  client.pipe.request = async (method, value) => { params = value; return { success: true, contentItems: [{ type: 'inputText', text: '{"threadId":"target"}' }] }; };
  await client.send('target', 'hello');
  assert.deepEqual(params.arguments, { hostId: 'local', threadId: 'target', prompt: 'hello' });
  assert.equal(params.threadId, 'source');
  assert.equal(params.turnId, 'source-turn');
  await assert.rejects(client.call('run_shell', {}), /unavailable/);
});

test('reused transport preserves in-flight source and explicit per-call identity across callers', async () => {
  const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'A', callerTurnId: 'turn-A' });
  client.tools = new Map(['send_message_to_thread', 'read_thread'].map(name => [name, { namespace: 'codex_app' }]));
  const requests = [];
  let finish;
  client.pipe.request = async (_method, params) => {
    requests.push(structuredClone(params));
    if (params.tool === 'send_message_to_thread') return new Promise(resolve => { finish = resolve; });
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ thread: { id: params.arguments.threadId, hostId: 'local', kind: 'codex' } }) }] };
  };
  const pending = client.send('target', 'first');
  client.setCaller('B', 'turn-B');
  await client.read('A', {}, { hostId: 'local', callerThreadId: 'A', callerTurnId: 'turn-A2' });
  await client.read('B');
  finish({ success: true, contentItems: [{ type: 'inputText', text: '{"threadId":"target"}' }] });
  await pending;
  assert.deepEqual(requests.map(p => [p.threadId, p.turnId]), [['A', 'turn-A'], ['A', 'turn-A2'], ['B', 'turn-B']]);
});

test('read rejects mismatched or remote target identity', async () => {
  const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'source' });
  for (const thread of [{ id: 'wrong', hostId: 'local', kind: 'codex' }, { id: 'target', hostId: 'remote', kind: 'codex' }]) {
    client.call = async () => ({ thread });
    await assert.rejects(client.read('target'), /expected local main chat/);
  }
});

test('calibrated Desktop not-found response rejects an unavailable target instead of treating it as a disconnected pipe', async () => {
  const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'source' });
  client.tools = new Map([['read_thread', { namespace: 'codex_app' }]]);
  client.pipe.request = async () => ({ success: false, contentItems: [{ type: 'inputText',
    text: 'No Codex thread found for threadId: target. Hosts without a readable match: local, durable' }] });
  await assert.rejects(client.read('target'), e => e.code === 'TARGET_UNAVAILABLE');
});

const tooLargeReply = { success: false, contentItems: [{ type: 'inputText', text:
  'Tool response exceeds the size limit. Request fewer turns or omit outputs. A single oversized turn cannot be returned by this tool.' }] };

test('an explicitly oversized read retries one turn with the same cursor, outputs and calling identity', async () => {
  const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'source', callerTurnId: 'source-turn' });
  client.tools = new Map([['read_thread', { namespace: 'codex_app' }]]);
  const calls = [];
  const data = { thread: { id: 'target', hostId: 'local', kind: 'codex' },
    turns: [{ id: 'older', items: [{ type: 'agentMessage', phase: 'final_answer', text: '完整结果' }] }],
    page: { hasMore: true, nextCursor: 'after-older' } };
  client.pipe.request = async (_method, params) => {
    calls.push(structuredClone(params));
    if (calls.length === 1) {
      client.setCaller('another', 'another-turn');
      return tooLargeReply;
    }
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
  };
  assert.deepEqual(await client.read('target', { cursor: 'before-older', includeOutputs: true }), data);
  assert.deepEqual(calls.map(c => c.arguments.turnLimit), [10, 1]);
  for (const call of calls) {
    assert.equal(call.threadId, 'source');
    assert.equal(call.turnId, 'source-turn');
    assert.equal(call.arguments.cursor, 'before-older');
    assert.equal(call.arguments.includeOutputs, true);
    assert.equal(call.arguments.maxOutputCharsPerItem, 18000);
  }
  calls.length = 0;
  data.thread.id = 'wrong-target';
  await assert.rejects(client.read('target'), e => e.code === 'TARGET_UNAVAILABLE');
});

test('one oversized turn remains a bounded, explicit read error', async () => {
  for (const turnLimit of [10, 1]) {
    const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'source' });
    client.tools = new Map([['read_thread', { namespace: 'codex_app' }]]);
    let calls = 0;
    client.pipe.request = async () => { calls++; return tooLargeReply; };
    await assert.rejects(client.read('target', { turnLimit }), e => e.code === 'DESKTOP_RESPONSE_TOO_LARGE');
    assert.equal(calls, turnLimit === 1 ? 1 : 2);
  }
});

test('read retries exclude other rejections, transport failures and malformed replies; writes are never retried', async () => {
  for (const [reply, code] of [
    [{ success: false, contentItems: [{ type: 'inputText', text: 'Access denied' }] }, 'DESKTOP_TOOL_REJECTED'],
    [{ contentItems: tooLargeReply.contentItems }, undefined],
    [{ success: true, contentItems: [{ type: 'inputText', text: 'invalid-json' }] }, undefined],
    [new Error('Desktop tools/call timed out; write outcome may be unknown'), undefined],
  ]) {
    const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'source' });
    client.tools = new Map([['read_thread', { namespace: 'codex_app' }]]);
    let calls = 0;
    client.pipe.request = async () => { calls++; if (reply instanceof Error) throw reply; return reply; };
    await assert.rejects(client.read('target'), e => e.code === code);
    assert.equal(calls, 1);
  }
  const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'source' });
  client.tools = new Map([['send_message_to_thread', { namespace: 'codex_app' }]]);
  let calls = 0;
  client.pipe.request = async () => { calls++; return tooLargeReply; };
  await assert.rejects(client.send('target', 'execute once'), e => e.code === 'DESKTOP_TOOL_REJECTED');
  assert.equal(calls, 1);
});

const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const stringSchema = { type: 'string' };
function catalog() {
  return [
    ['list_threads', objectSchema({ limit: { type: 'integer' } })],
    ['read_thread', objectSchema({ threadId: stringSchema, hostId: stringSchema, cursor: stringSchema,
      turnLimit: { type: 'integer' }, includeOutputs: { type: 'boolean' }, maxOutputCharsPerItem: { type: 'integer' } }, ['threadId'])],
    ['send_message_to_thread', objectSchema({ threadId: stringSchema, hostId: stringSchema, prompt: stringSchema }, ['threadId', 'prompt'])],
    ['list_projects', objectSchema({})],
    ['create_thread', objectSchema({ prompt: stringSchema, target: { anyOf: [objectSchema({
      type: { type: 'string', enum: ['project'] }, projectId: stringSchema,
      environment: { anyOf: [objectSchema({ type: { type: 'string', enum: ['local'] } }, ['type'])] },
    }, ['type', 'projectId', 'environment']), objectSchema({ type: { type: 'string', enum: ['projectless'] },
      directoryName: stringSchema }, ['type'])] }, model: stringSchema, thinking: stringSchema, title: stringSchema }, ['prompt', 'target'])],
  ].map(([name, inputSchema]) => ({ name, namespace: 'codex_app', inputSchema }));
}
function catalogClient(tools) {
  const client = new DesktopClient({ pipePath: 'unused', callerThreadId: 'source', callerTurnId: 'turn' });
  const calls = [];
  client.pipe.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'tools/list') return { tools };
    const data = params.tool === 'read_thread' ? { thread: { id: 'source', hostId: 'local', kind: 'codex' } } :
      params.tool === 'list_projects' ? { schemaVersion: 2, projects: [] } : { threadId: 'created', hostId: 'local' };
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
  };
  return { client, calls };
}

test('calibrated project tools use exact local target and omit model, thinking, title and permissions', async () => {
  const { client, calls } = catalogClient(catalog());
  await client.validate();
  assert.deepEqual(await client.projects(), { schemaVersion: 2, projects: [] });
  const projectCall = calls.at(-1);
  assert.equal(projectCall.params.tool, 'list_projects');
  assert.deepEqual(projectCall.params.arguments, {});
  assert.deepEqual(await client.create('bot-id', '首条要求'), { threadId: 'created', hostId: 'local' });
  const request = calls.at(-1);
  assert.equal(request.method, 'tools/call');
  assert.equal(request.params.tool, 'create_thread');
  assert.deepEqual(request.params.arguments, { target: { type: 'project', projectId: 'bot-id', environment: { type: 'local' } }, prompt: '首条要求' });
  assert.equal(request.params.threadId, 'source');
  assert.equal(request.params.turnId, 'turn');
  assert.throws(() => client.create('', 'prompt'), /项目 ID/);
  assert.throws(() => client.create('id', ' '), /首条要求/);
  await assert.rejects(client.call('arbitrary_tool', {}), /unavailable/);
});

test('projectless creation uses only its target type and prompt, without project-list capability', async () => {
  const { client, calls } = catalogClient(catalog().filter(t => t.name !== 'list_projects'));
  await client.validate();
  assert.equal(client.canCreate(null), true);
  assert.deepEqual(await client.create(null, '首条要求'), { threadId: 'created', hostId: 'local' });
  assert.deepEqual(calls.at(-1).params.arguments, { target: { type: 'projectless' }, prompt: '首条要求' });
  assert.equal(calls.some(c => c.params?.tool === 'list_projects'), false);
  for (const id of [undefined, '', ' ', 42]) assert.throws(() => client.create(id, 'prompt'), /项目 ID/);
  assert.throws(() => client.create(null, ' '), /首条要求/);
});

test('creation modes are calibrated independently and unsupported modes never dispatch', async () => {
  for (const supported of ['project', 'projectless']) {
    const tools = catalog();
    tools.find(t => t.name === 'create_thread').inputSchema.properties.target.anyOf =
      tools.find(t => t.name === 'create_thread').inputSchema.properties.target.anyOf
        .filter(s => s.properties.type.enum.includes(supported));
    const { client, calls } = catalogClient(tools);
    await client.validate();
    const supportedId = supported === 'project' ? 'bot-id' : null;
    const unsupportedId = supported === 'project' ? null : 'bot-id';
    assert.equal(client.canCreate(supportedId), true);
    assert.equal(client.canCreate(unsupportedId), false);
    await client.create(supportedId, 'prompt');
    const before = calls.length;
    await assert.rejects(client.create(unsupportedId, 'prompt'), /新建聊天功能不可用/);
    assert.equal(calls.length, before);
    await client.send('source', 'existing conversation still works');
  }
});

test('missing or incompatible optional creation tools leave existing tools usable', async () => {
  for (const alter of [
    tools => tools.filter(t => !['list_projects', 'create_thread'].includes(t.name)),
    tools => tools.map(t => t.name === 'create_thread' ? { ...t, inputSchema: objectSchema({ prompt: stringSchema }, ['prompt', 'mandatoryOverride']) } : t),
    tools => tools.map(t => t.name === 'create_thread' ? { ...t, inputSchema: objectSchema({ prompt: stringSchema, target: objectSchema({}) }, ['prompt', 'target']) } : t),
    tools => tools.map(t => t.name === 'create_thread' ? { ...t, inputSchema: objectSchema({}) } : t),
  ]) {
    const { client, calls } = catalogClient(alter(catalog()));
    await client.validate();
    await client.list();
    await client.read('source');
    await client.send('source', 'hello');
    const before = calls.length;
    await assert.rejects(client.create('id', 'prompt'), /新建聊天功能不可用/);
    assert.equal(calls.length, before);
  }
  const { client } = catalogClient(catalog().map(t => t.name === 'list_projects' ? { ...t, inputSchema: objectSchema({}, ['secret']) } : t));
  await client.validate();
  await assert.rejects(client.projects(), /list_projects.*不兼容/);
});

test('all three existing desktop tools remain mandatory during calibration', async () => {
  for (const name of ['list_threads', 'read_thread', 'send_message_to_thread']) {
    const { client } = catalogClient(catalog().filter(t => t.name !== name));
    await assert.rejects(client.validate(), new RegExp(name));
  }
});
