import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../src/daemon.mjs';
import { localCall, readRuntime } from '../src/local-runtime.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-daemon-'));
  let closes = 0;
  const fakeDesktop = { validate: async () => ({ thread: { id: 'main', hostId: 'local', kind: 'codex', title: 'Main', status: { type: 'idle' } } }),
    read: async id => ({ thread: { id, hostId: 'local', kind: 'codex', title: id, status: { type: 'idle' } }, turns: [] }), close: () => { closes++; } };
  const opts = { dir, loop: false, desktopFactory: () => ({ ...fakeDesktop }), ...extra };
  let service = await startDaemon(opts);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, get service() { return service; }, closes: () => closes, async restart() { await service.close(); service = await startDaemon(opts); return service; } };
}

test('actual local daemon rejects missing authorization and browser origins, and never leaks runtime token', async t => {
  const f = await fixture(t);
  const runtime = await readRuntime(f.dir);
  const url = `http://127.0.0.1:${runtime.port}/status`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'x-wechatbot-instance': runtime.instanceId, origin: 'https://example.com' }, body: '{}' })).status, 403);
  const result = await localCall(f.dir, '/status');
  assert.equal(result.weixin, 'not_configured');
  assert.equal(JSON.stringify(result).includes(runtime.token), false);
  await assert.rejects(startDaemon({ dir: f.dir, loop: false }), /ownership/);
});

test('corrupt obsolete runtime is replaced after ownership, and stop releases the owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-old-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'runtime.json'), '{obsolete');
  const service = await startDaemon({ dir, loop: false });
  t.after(() => service.close());
  assert.equal((await readRuntime(dir)).instanceId, service.runtime.instanceId);
  assert.equal((await localCall(dir, '/health')).service, 'wechatbot');
  await service.close();
  await assert.rejects(readFile(join(dir, 'owner.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, 'runtime.json')), { code: 'ENOENT' });
});

test('business JSON corruption is preserved and startup releases ownership', async t => {
  for (const name of ['state.json', 'credentials.json', 'config.json']) {
    await t.test(name, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'wechatbot-corrupt-state-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      await writeFile(join(dir, name), '{broken');
      await assert.rejects(startDaemon({ dir, loop: false }), SyntaxError);
      assert.equal(await readFile(join(dir, name), 'utf8'), '{broken');
      await assert.rejects(readFile(join(dir, 'owner.lock')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(dir, 'runtime.json')), { code: 'ENOENT' });
    });
  }
});

test('runtime cleanup preserves unknown or other-instance files and always releases its owner', async t => {
  for (const contents of ['{broken', JSON.stringify({ instanceId: 'another-instance' })]) {
    await t.test(contents, async t => {
      const f = await fixture(t);
      await writeFile(join(f.dir, 'runtime.json'), contents);
      await f.service.close();
      assert.equal(await readFile(join(f.dir, 'runtime.json'), 'utf8'), contents);
      await assert.rejects(readFile(join(f.dir, 'owner.lock')), { code: 'ENOENT' });
    });
  }
});

test('runtime cleanup IO failure still releases ownership', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-runtime-cleanup-'));
  const service = await startDaemon({ dir, loop: false });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await rm(join(dir, 'runtime.json'));
  await mkdir(join(dir, 'runtime.json'));
  await assert.rejects(service.close());
  await assert.rejects(readFile(join(dir, 'owner.lock')), { code: 'ENOENT' });
});

test('MCP rejects unknown tools and mismatched caller connection before registration', async t => {
  const f = await fixture(t);
  let registrations = 0;
  f.service.bridge.register = async () => { registrations++; };
  const connection = { pipePath: '\\\\.\\pipe\\test-bridge', hostId: 'local', callerThreadId: 'main', callerTurnId: 'turn' };
  await assert.rejects(localCall(f.dir, '/mcp', { connection, caller: { threadId: 'main', turnId: 'turn' }, tool: 'unknown' }), /Unknown MCP tool/);
  await assert.rejects(localCall(f.dir, '/mcp', { connection, caller: { threadId: 'second', turnId: 'turn' }, tool: 'wechat_status' }), /identity mismatch/);
  await assert.rejects(localCall(f.dir, '/mcp', { connection, caller: { threadId: 'main', turnId: 'another-turn' }, tool: 'wechat_status' }), /identity mismatch/);
  await assert.rejects(localCall(f.dir, '/mcp', { connection, caller: { threadId: '' }, tool: 'wechat_status' }), /Missing MCP calling identity/);
  assert.equal(registrations, 0);
});

test('daemon restart revalidates a saved candidate and preserves chat number and explicit selection', async t => {
  const f = await fixture(t);
  const connection = { pipePath: '\\\\.\\pipe\\test-bridge', hostId: 'local', callerThreadId: 'main', callerTurnId: 'turn' };
  await localCall(f.dir, '/register', { connection });
  await localCall(f.dir, '/mcp', { caller: { threadId: 'main' }, tool: 'wechat_select_current_chat', arguments: {} });
  const before = f.service.runtime.instanceId;
  await f.restart();
  assert.notEqual(f.service.runtime.instanceId, before);
  const state = await localCall(f.dir, '/status');
  assert.equal(state.desktop, 'connected');
  assert.equal(state.selected.number, 1);
  assert.equal(state.selected.threadId, 'main');
});

test('global notification mode is visible through local status and survives daemon restart', async t => {
  const f = await fixture(t);
  assert.equal((await localCall(f.dir, '/status')).notificationMode, 'full');
  await f.service.bridge.setNotificationMode('brief');
  await f.restart();
  const status = await localCall(f.dir, '/status');
  assert.equal(status.notificationMode, 'brief');
  assert.equal(status.selected, null);
  assert.deepEqual(status.subscriptions, []);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'config.json'), 'utf8')).notificationMode, 'brief');
});

test('doctor distinguishes a caller read rejection from a failed desktop connection', async t => {
  const f = await fixture(t);
  await localCall(f.dir, '/register', { connection: {
    pipePath: '\\\\.\\pipe\\test-doctor-rejections', hostId: 'local', callerThreadId: 'main',
  } });
  const validate = f.service.bridge.desktop.validate;
  for (const code of ['DESKTOP_RESPONSE_TOO_LARGE', 'TARGET_UNAVAILABLE', 'DESKTOP_TOOL_REJECTED', undefined]) {
    f.service.bridge.errors.desktop = 'previous failure';
    f.service.bridge.desktop.validate = async () => { throw Object.assign(new Error('check failed'), code ? { code } : {}); };
    const status = await localCall(f.dir, '/doctor');
    assert.equal(status.desktop, code ? 'connected' : 'disconnected');
    assert.equal(status.desktopCheck.compatible, false);
    assert.equal(status.desktopCheck.errorCode, code);
  }
  f.service.bridge.desktop.validate = async () => ({ ...await validate(), tools: { read_thread: {} } });
  const recovered = await localCall(f.dir, '/doctor');
  assert.equal(recovered.desktop, 'connected');
  assert.equal(recovered.desktopCheck.compatible, true);
});

test('same-pipe caller registration does not close a transport with ongoing work', async t => {
  const f = await fixture(t);
  const connection = { pipePath: '\\\\.\\pipe\\test-bridge', hostId: 'local', callerThreadId: 'main' };
  await localCall(f.dir, '/register', { connection });
  const original = f.service.bridge.desktop;
  await localCall(f.dir, '/register', { connection: { ...connection, callerTurnId: 'new-turn' } });
  assert.equal(f.service.bridge.desktop, original);
  assert.equal(f.closes(), 0);
});

test('MCP on a validated pipe reads and saves each current-chat action once', async t => {
  let validations = 0, reads = 0;
  const f = await fixture(t, { desktopFactory: connection => ({
    connection,
    setCaller(caller) { this.connection = caller; },
    validate: async () => {
      validations++;
      return { thread: { id: connection.callerThreadId, hostId: 'local', kind: 'codex', title: 'Main', status: { type: 'idle' } } };
    },
    read: async id => {
      reads++;
      return { thread: { id, hostId: 'local', kind: 'codex', title: id, status: { type: 'idle' } }, turns: [] };
    },
    close() {},
  }) });
  const connection = { pipePath: '\\\\.\\pipe\\test-mcp-counts', hostId: 'local', callerThreadId: 'main', callerTurnId: 'first-turn' };
  await localCall(f.dir, '/register', { connection });
  let updates = 0;
  const update = f.service.bridge.state.update.bind(f.service.bridge.state);
  f.service.bridge.state.update = mutator => { updates++; return update(mutator); };
  for (const legacy of [false, true]) {
    for (const tool of ['wechat_status', 'wechat_set_notifications', 'wechat_select_current_chat']) {
      const before = { validations, reads, updates };
      await localCall(f.dir, '/mcp', { ...(legacy ? {} : { connection }),
        caller: { threadId: 'main', turnId: 'first-turn' }, tool, arguments: { enabled: true } });
      assert.equal(validations, before.validations, `${tool}: repeated validation`);
      assert.equal(reads, before.reads + 1, `${tool}: current-chat read count`);
      assert.equal(updates, before.updates + 1, `${tool}: state save count`);
    }
  }
});

test('QR confirmation persists credentials inside daemon and only returns public login status', async t => {
  const f = await fixture(t, { weixin: {
    getQr: async () => ({ qrcode: 'secret-qr', qrcode_img_content: 'qr-payload' }),
    pollQr: async () => ({ status: 'confirmed', bot_token: 'secret-token', ilink_bot_id: 'bot', ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' }),
  } });
  await f.service.bridge.credentials.update(c => { c.contextToken = 'old-context'; });
  await f.service.bridge.config.update(c => { c.boundAt = '2026-10-01T00:00:00.000Z'; });
  const qr = await localCall(f.dir, '/login/start');
  assert.equal(qr.payload, 'qr-payload');
  for (let i = 0; i < 50; i++) { if ((await localCall(f.dir, '/login/status')).status === 'confirmed') break; await delay(10); }
  const status = await localCall(f.dir, '/login/status');
  assert.equal(status.status, 'confirmed');
  assert.equal(JSON.stringify(status).includes('secret-token'), false);
  // Status cannot claim bound until the account's first validated inbound message.
  assert.equal((await localCall(f.dir, '/status')).weixin, 'awaiting_owner_message');
  const saved = JSON.parse(await readFile(join(f.dir, 'credentials.json'), 'utf8'));
  assert.equal(saved.botToken, 'secret-token');
  assert.equal(Object.hasOwn(saved, 'contextToken'), false);
  assert.equal(Object.hasOwn(saved, 'contextVersion'), false);
});

test('formal stdio MCP forwards distinct calling chats through the authenticated daemon', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'integration-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dirname, '../src/mcp.mjs')], env: { PATH: process.env.PATH || '',
      WECHATBOT_DATA_DIR: f.dir, CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\test-mcp', CODEX_THREAD_ID: 'must-not-use' } });
  t.after(() => client.close());
  await client.connect(transport);
  async function call(threadId, name, arguments_ = {}) {
    // Synthetic executor metadata in this integration check; actual automatic injection has separate P0 proof.
    const result = await client.callTool({ name, arguments: arguments_, _meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, turn_id: `turn-${threadId}` }) } });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  const a = await call('main', 'wechat_status');
  assert.equal(a.caller.threadId, 'main');
  const b = await call('second', 'wechat_status');
  assert.equal(b.caller.threadId, 'second');
  assert.notEqual(a.chat.number, b.chat.number);
  await call('main', 'wechat_select_current_chat');
  await call('main', 'wechat_set_notifications', { enabled: true });
  await call('second', 'wechat_select_current_chat');
  const s = await localCall(f.dir, '/status');
  assert.equal(s.selected.threadId, 'second');
  assert.equal(s.subscriptions.length, 1);
  assert.equal(s.subscriptions[0].number, b.chat.number);
  assert.equal((await call('main', 'wechat_status')).chat.enabled, false);
  await call('second', 'wechat_set_notifications', { enabled: false });
  assert.equal((await localCall(f.dir, '/status')).subscriptions.length, 0);
});
