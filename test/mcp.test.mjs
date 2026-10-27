import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setTimeout as delay } from 'node:timers/promises';
import { localCall, readRuntime } from '../src/local-runtime.mjs';
import { startDaemon } from '../src/daemon.mjs';

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`Timed out waiting for test condition: ${lastError?.message || 'not ready'}`);
}

async function stopTemporaryDaemon(dir) {
  if (!await readRuntime(dir)) return;
  await localCall(dir, '/stop');
  await waitFor(async () => !await readRuntime(dir));
  await waitFor(async () => !(await readdir(dir)).includes('owner.lock'));
}

function stdioClient(dir, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dirname, '../src/mcp.mjs')], cwd: tmpdir(),
    env: { PATH: process.env.PATH || '', WECHATBOT_DATA_DIR: dir, ...extraEnv } });
  return { client: new Client({ name: 'startup-test', version: '1' }), transport };
}

const trustedStatus = { name: 'wechat_status', arguments: {},
  _meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'main', turn_id: 'startup-check' }) } };

test('MCP startup recovers a missing temporary daemon without any tool call and preserves explicit stop', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-mcp-recovery-'));
  const { client, transport } = stdioClient(dir);
  t.after(async () => { await client.callTool(trustedStatus).catch(() => {}); await client.close(); await stopTemporaryDaemon(dir); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 3);
  const health = await waitFor(() => localCall(dir, '/health', {}, { timeoutMs: 500 }));
  assert.equal(health.service, 'wechatbot');
  assert.notEqual(health.pid, process.pid);
  // The daemon is already healthy without tools; this read waits for the one
  // startup attempt to settle before the later explicit stop and cleanup.
  const ready = await client.callTool(trustedStatus);
  assert.equal(ready.isError, true);
  assert.match(ready.content[0].text, /Expected local Desktop pipe/);
  const before = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.equal(before.selected, null);
  assert.deepEqual(before.chats, {});
  const missingCaller = await client.callTool({ name: 'wechat_select_current_chat', arguments: {} });
  assert.equal(missingCaller.isError, true);
  assert.match(missingCaller.content[0].text, /Missing trusted/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), before);
  await stopTemporaryDaemon(dir);
  const stopped = await client.callTool({ name: 'wechat_status', arguments: {},
    _meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'main', turn_id: 'after-stop' }) } });
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /not running|不可达/);
  assert.equal(await readRuntime(dir), null);
});

test('real stdio MCP advertises exactly three tools and rejects missing caller identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-mcp-test-'));
  // A directory cannot be appended as a P0 log file, on Windows or POSIX.
  await mkdir(join(dir, 'p0-mcp.jsonl'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '../src/mcp.mjs')],
    env: { PATH: process.env.PATH || '', WECHATBOT_DATA_DIR: dir, CODEX_THREAD_ID: 'must-not-be-used' } });
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.callTool(trustedStatus).catch(() => {}); await client.close(); await stopTemporaryDaemon(dir); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['wechat_set_notifications', 'wechat_select_current_chat', 'wechat_status']);
  const result = await client.callTool({ name: 'wechat_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Missing trusted/);
  assert.deepEqual(await readdir(join(dir, 'p0-mcp.jsonl')), []);
  await waitFor(() => localCall(dir, '/health', {}, { timeoutMs: 500 }));
  await client.callTool(trustedStatus);
});

test('MCP reload reuses daemon PID and registers the new pipe without changing selection or subscriptions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-mcp-reload-'));
  const thread = { id: 'saved-chat', hostId: 'local', kind: 'codex', title: 'Saved', status: { type: 'idle' } };
  const service = await startDaemon({ dir, loop: false, desktopFactory: () => ({
    validate: async () => ({ thread }), read: async () => ({ thread, turns: [] }), close() {},
  }) });
  const oldPipe = '\\\\.\\pipe\\old-mcp-test';
  const newPipe = '\\\\.\\pipe\\new-mcp-test';
  await localCall(dir, '/register', { connection: { pipePath: oldPipe, hostId: 'local', callerThreadId: thread.id } });
  await service.bridge.select(thread.id);
  await service.bridge.setNotifications(thread.id, true);
  const before = service.bridge.state.read();
  const { client, transport } = stdioClient(dir, { CODEX_APP_TOOLS_PIPE_PATH: newPipe });
  t.after(async () => { await client.close(); await service.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  await waitFor(() => service.bridge.connection?.pipePath === newPipe);
  assert.equal((await localCall(dir, '/health')).pid, service.runtime.pid);
  assert.equal((await readdir(dir)).includes('logs'), true);
  await assert.rejects(readFile(join(dir, 'logs', 'startup.log')), { code: 'ENOENT' });
  const result = await client.callTool({ name: 'wechat_set_notifications', arguments: { enabled: false } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Missing trusted/);
  assert.equal(service.bridge.state.read().selected, before.selected);
  assert.deepEqual(service.bridge.state.read().chats, before.chats);
});

test('failed startup preserves a live owner, keeps tools discoverable, and allows later manual recovery without retrying start', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-mcp-blocked-'));
  const owner = { pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() };
  const ownerText = JSON.stringify(owner);
  await writeFile(join(dir, 'owner.lock'), ownerText);
  const { client, transport } = stdioClient(dir, { CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\recovered-mcp-test' });
  let service;
  t.after(async () => { await client.close(); await service?.close(); await rm(dir, { recursive: true, force: true }); });
  const connectStarted = Date.now();
  await client.connect(transport);
  // A failed startup may exhaust the CLI's bounded wait; discovery must not wait.
  assert.equal((await client.listTools()).tools.length, 3);
  assert.ok(Date.now() - connectStarted < 5000, 'stdio discovery must not wait for the failed daemon startup');
  const failed = await client.callTool(trustedStatus);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /启动恢复失败/);
  assert.equal(await readFile(join(dir, 'owner.lock'), 'utf8'), ownerText);
  const startupLog = await readFile(join(dir, 'logs', 'startup.log'), 'utf8');
  assert.match(startupLog, /ownership is held/);
  const again = await client.callTool(trustedStatus);
  assert.equal(again.isError, true);
  assert.equal(await readFile(join(dir, 'logs', 'startup.log'), 'utf8'), startupLog);
  // Simulate the owner having explicitly released and the user starting the
  // service manually. The same MCP remains usable despite its startup failure.
  await rm(join(dir, 'owner.lock'));
  service = await startDaemon({ dir, loop: false, desktopFactory: () => ({
    validate: async () => ({ thread: { id: 'main', hostId: 'local', kind: 'codex', title: 'Main', status: { type: 'idle' } } }),
    read: async id => ({ thread: { id, hostId: 'local', kind: 'codex', title: id, status: { type: 'idle' } }, turns: [] }), close() {},
  }) });
  const recovered = await client.callTool(trustedStatus);
  assert.notEqual(recovered.isError, true, recovered.content[0].text);
  assert.equal(await readFile(join(dir, 'logs', 'startup.log'), 'utf8'), startupLog);
});

test('each stdio tool call sends its own trusted metadata in one daemon request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-mcp-caller-'));
  const requests = [];
  const instanceId = randomUUID();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ instanceId, result: { caller: body.caller } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ pid: process.pid, instanceId, host: '127.0.0.1', port: server.address().port, token: 'a'.repeat(43) }));
  const pipePath = '\\\\.\\pipe\\mcp-request-count';
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '../src/mcp.mjs')],
    env: { PATH: process.env.PATH || '', WECHATBOT_DATA_DIR: dir, CODEX_APP_TOOLS_PIPE_PATH: pipePath,
      CODEX_THREAD_ID: 'must-not-be-used', CODEX_VERSION: 'test-version' } });
  t.after(async () => {
    await client.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  await waitFor(() => requests.some(r => r.path === '/desktop-discovery'));
  assert.deepEqual(requests.map(r => r.path), ['/health', '/desktop-discovery']);
  for (const [threadId, turnId] of [['first-chat', 'first-turn'], ['second-chat', 'second-turn'], ['first-chat', 'third-turn']]) {
    const before = requests.length;
    const result = await client.callTool({ name: 'wechat_status', arguments: {},
      _meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, turn_id: turnId }) } });
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(requests.length, before + 1);
    assert.deepEqual(requests.at(-1), { path: '/mcp', body: {
      connection: { pipePath, hostId: 'local', codeVersion: 'test-version', callerThreadId: threadId, callerTurnId: turnId },
      caller: { threadId, turnId }, tool: 'wechat_status', arguments: {},
    } });
  }
  assert.equal(JSON.stringify(requests).includes('must-not-be-used'), false);
  assert.equal((await readdir(dir)).includes('p0-mcp.jsonl'), false);
});
