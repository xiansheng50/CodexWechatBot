import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localCall, readRuntime } from '../src/local-runtime.mjs';

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function pipeServer(path, respond) {
  const sockets = new Set();
  const requests = [];
  const errors = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => errors.push(error));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        requests.push({ ...request, at: Date.now() });
        const result = respond(request);
        if (result === undefined) continue;
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(payload.length);
        socket.write(Buffer.concat([header, payload]));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return { requests, errors, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

test('MCP startup registers the current pipe after the saved pipe hits its real request timeout', {
  skip: process.platform !== 'win32' && 'requires Windows named pipes', timeout: 75000,
}, async t => {
  const prefix = join(tmpdir(), 'wechatbot-mcp-slow-start-');
  const dir = await mkdtemp(prefix);
  // Only this newly-created temporary tree may be removed, never the real state.
  const target = resolve(dir);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep));
  assert.ok(target.startsWith(resolve(prefix)));
  const id = randomUUID();
  const oldPath = `\\\\.\\pipe\\wechatbot-slow-old-${id}`;
  const newPath = `\\\\.\\pipe\\wechatbot-slow-new-${id}`;
  const thread = { id: 'saved-main', hostId: 'local', kind: 'codex', title: 'Saved main', status: { type: 'idle' } };
  const observation = { anchor: 'already-observed', pending: [] };
  const before = { version: 1, nextNumber: 18, selected: thread.id,
    chats: { [thread.id]: { threadId: thread.id, hostId: 'local', number: 17, title: thread.title,
      status: 'idle', enabled: true, enabledAt: '2026-01-01T00:00:00.000Z', observation } },
    desktopCandidate: { pipePath: oldPath, hostId: 'local', callerThreadId: thread.id, callerTurnId: 'saved-turn' },
    cursor: 'saved-cursor',
    inbound: [{ id: 'accepted-input', status: 'completed', target: thread.id, prompt: 'already handled', turnId: observation.anchor }],
    notifications: [{ id: 'accepted-notice', kind: 'reply', text: 'already delivered', status: 'accepted', clientId: 'stable-client-id' }] };
  await writeFile(join(dir, 'state.json'), JSON.stringify(before));
  let oldPipe, newPipe, client;
  let launched = false;
  t.after(async () => {
    try {
      if (launched) {
        // Startup owns a detached process. Wait for initialization even if an
        // assertion failed early; deleting now would permit late state writes.
        const health = await waitFor(() => localCall(dir, '/health', {}, { timeoutMs: 500 }), 45000, 'temporary daemon initialization before cleanup');
        await client?.close();
        await localCall(dir, '/stop');
        await waitFor(async () => !await readRuntime(dir) && !(await readdir(dir)).includes('owner.lock'), 10000, 'temporary daemon ownership release');
        await waitFor(() => { try { process.kill(health.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 10000, 'temporary daemon process exit');
      }
      await rm(target, { recursive: true, force: true });
    } finally {
      await client?.close();
      await oldPipe?.close();
      await newPipe?.close();
    }
  });
  // This is deliberately the production 20-second NativePipeClient timeout:
  // accepting the socket without answering tools/list reproduces the gap
  // beyond CLI start's approximately eight-second health wait.
  oldPipe = await pipeServer(oldPath, () => undefined);
  const properties = keys => Object.fromEntries(keys.map(key => [key, {
    type: key === 'includeOutputs' ? 'boolean' : ['limit', 'turnLimit', 'maxOutputCharsPerItem'].includes(key) ? 'integer' : 'string',
  }]));
  const tools = [
    { name: 'list_threads', namespace: 'test', inputSchema: { type: 'object', properties: properties(['limit']) } },
    { name: 'read_thread', namespace: 'test', inputSchema: { type: 'object', properties: properties(['threadId', 'hostId', 'cursor', 'turnLimit', 'includeOutputs', 'maxOutputCharsPerItem']) } },
    { name: 'send_message_to_thread', namespace: 'test', inputSchema: { type: 'object', properties: properties(['threadId', 'hostId', 'prompt']) } },
  ];
  newPipe = await pipeServer(newPath, request => {
    if (request.method === 'tools/list') return { tools };
    assert.equal(request.method, 'tools/call');
    assert.equal(request.params.tool, 'read_thread', 'startup must never resubmit accepted input');
    assert.equal(request.params.arguments.threadId, thread.id);
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ thread,
      turns: [{ id: observation.anchor, status: 'completed', items: [] }], page: { hasMore: false } }) }] };
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dirname, '../src/mcp.mjs')], cwd: tmpdir(),
    env: { PATH: process.env.PATH || '', WECHATBOT_DATA_DIR: dir, CODEX_APP_TOOLS_PIPE_PATH: newPath } });
  client = new Client({ name: 'slow-start-regression', version: '1' });
  launched = true;
  const startedAt = Date.now();
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 3);
  assert.ok(Date.now() - startedAt < 5000, 'MCP discovery must remain available during recovery');
  await waitFor(() => oldPipe.requests.length > 0, 5000, 'saved pipe tools/list request');
  assert.equal(oldPipe.requests[0].method, 'tools/list');
  const health = await waitFor(() => localCall(dir, '/health', {}, { timeoutMs: 500 }), 35000, 'daemon health after real saved-pipe timeout');
  assert.ok(Date.now() - oldPipe.requests[0].at >= 19500, 'saved pipe must reach the real 20-second request timeout');
  t.diagnostic(`daemon became healthy ${Date.now() - oldPipe.requests[0].at} ms after the unanswered saved-pipe request`);
  await waitFor(async () => (await localCall(dir, '/status')).desktop === 'connected',
    Math.max(1000, 45000 - (Date.now() - startedAt)), 'automatic current-pipe registration without an MCP tool call');
  assert.equal((await localCall(dir, '/health')).pid, health.pid);
  assert.ok(newPipe.requests.some(r => r.method === 'tools/list'));
  assert.ok(newPipe.requests.some(r => r.method === 'tools/call' && r.params.tool === 'read_thread'));
  assert.deepEqual(oldPipe.errors, []);
  assert.deepEqual(newPipe.errors, []);
  const after = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(after.desktopCandidate, { ...before.desktopCandidate, pipePath: newPath });
  assert.equal(after.selected, before.selected);
  assert.equal(after.nextNumber, before.nextNumber);
  assert.deepEqual(after.chats, before.chats);
  assert.equal(after.cursor, before.cursor);
  assert.deepEqual(after.inbound, before.inbound);
  assert.deepEqual(after.notifications, before.notifications);
  const events = (await readFile(join(dir, 'logs', 'bridge.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.event === 'daemon_started').length, 1, 'recovery must reuse the daemon already initializing');
  t.diagnostic(`real saved-pipe timeout and automatic discovery completed in ${Date.now() - startedAt} ms`);
});
