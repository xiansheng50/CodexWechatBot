import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Bridge, INITIAL_STATE } from '../src/bridge.mjs';
import { JsonStore } from '../src/state-store.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wechatbot-shutdown-test-'));
  t.after(async () => {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('wechatbot-shutdown-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const state = new JsonStore(join(directory, 'state.json'), INITIAL_STATE);
  const credentials = new JsonStore(join(directory, 'credentials.json'), {
    botToken: 'test-bot-token', botId: 'bot', userId: 'owner',
    contextToken: 'test-context', contextVersion: 1,
  });
  const config = new JsonStore(join(directory, 'config.json'), {});
  await Promise.all([state.load(), credentials.load(), config.load()]);
  const bridge = new Bridge({ state, credentials, config,
    weixin: { async sendText() { throw new Error('Unexpected external send'); } }, ...overrides });
  t.after(() => bridge.close());
  return { bridge, state, credentials, config, directory };
}

test('closing during registration cannot reactivate the desktop connection', async t => {
  const validating = deferred();
  const release = deferred();
  let clientCloses = 0;
  const h = await fixture(t, { desktopFactory: () => ({
    async validate() {
      validating.resolve();
      await release.promise;
      return { thread: { id: 'A', hostId: 'local', kind: 'codex', title: 'A' } };
    },
    close() { clientCloses++; },
  }) });
  const registration = h.bridge.register({ callerThreadId: 'A', pipePath: 'test-only' });
  await validating.promise;
  h.bridge.close();
  release.resolve();
  await assert.rejects(registration, /stopping/i);
  assert.equal(h.bridge.closed, true);
  assert.equal(h.bridge.desktop, undefined);
  assert.equal(clientCloses, 1);
  assert.equal(h.state.read().desktopCandidate, null);
  const persisted = new JsonStore(join(h.directory, 'state.json'), INITIAL_STATE);
  await persisted.load();
  assert.equal(persisted.read().desktopCandidate, null);
});

test('closing during a notification finishes that attempt without starting the next', async t => {
  const sending = deferred();
  const release = deferred();
  const calls = [];
  const h = await fixture(t, { weixin: {
    async sendText(_credentials, message) {
      calls.push(message.text);
      sending.resolve();
      await release.promise;
      return { ret: 0 };
    },
  } });
  await h.bridge.reply('first', 'first notification');
  await h.bridge.reply('second', 'second notification');
  const pending = h.bridge.sendPending();
  await sending.promise;
  h.bridge.close();
  release.resolve();
  await pending;
  assert.deepEqual(calls, ['first notification']);
  assert.deepEqual(h.state.read().notifications.map(n => [n.id, n.status]), [
    ['first', 'accepted'], ['second', 'pending'],
  ]);
  const persisted = new JsonStore(join(h.directory, 'state.json'), INITIAL_STATE);
  await persisted.load();
  assert.deepEqual(persisted.read().notifications.map(n => n.status), ['accepted', 'pending']);
});

test('an owner message without reply context cannot announce a completed binding', async t => {
  const h = await fixture(t);
  await h.credentials.update(c => { delete c.contextToken; });
  const message = (id, contextToken) => ({
    message_id: id, from_user_id: 'owner', to_user_id: 'bot',
    message_type: 1, message_state: 2,
    item_list: [{ type: 1, text_item: { text: '帮助' } }],
    ...(contextToken ? { context_token: contextToken } : {}),
  });
  await h.bridge.acceptBatch({ get_updates_buf: 'cursor-1', msgs: [message('1')] });
  assert.equal(h.bridge.status().weixin, 'awaiting_owner_message');
  assert.equal(h.config.read().boundAt, undefined);
  assert.equal(h.state.read().cursor, 'cursor-1');
  assert.deepEqual(h.state.read().inbound.map(m => m.id), ['1']);
  assert.equal(h.state.read().notifications.some(n => n.id === 'binding'), false);

  await h.bridge.acceptBatch({ get_updates_buf: 'cursor-2', msgs: [message('2', 'fresh-context')] });
  assert.equal(h.credentials.read().contextToken, 'fresh-context');
  assert.equal(h.bridge.status().weixin, 'connected');
  assert.ok(h.config.read().boundAt);
  assert.equal(h.state.read().notifications.filter(n => n.id === 'binding').length, 1);
});
