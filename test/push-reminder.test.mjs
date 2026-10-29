import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge, INITIAL_STATE } from '../src/bridge.mjs';
import { JsonStore, writeJsonAtomic } from '../src/state-store.mjs';

const REMINDER = '连续推送可能已达微信限制。请发送一次“状态”，避免错过后续通知';
const SUFFIX = `\n\n${REMINDER}`;
const incoming = (id, extra = {}) => ({ message_id: String(id), from_user_id: 'owner', to_user_id: 'bot',
  message_type: 1, message_state: 2, context_token: 'same-token',
  item_list: [{ type: 1, text_item: { text: '状态' } }], ...extra });
const thread = id => ({ id, hostId: 'local', kind: 'codex', title: `聊天${id}`, status: { type: 'idle' } });

async function fixture(t, initialState = INITIAL_STATE) {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-push-reminder-'));
  const h = { notices: [], histories: new Map(), onSend: async () => {}, beforeStateWrite: async () => {} };
  h.restart = async () => {
    h.bridge?.close();
    h.state = new JsonStore(join(dir, 'state.json'), initialState, { write: async (path, value) => {
      await h.beforeStateWrite(value);
      await writeJsonAtomic(path, value);
    } });
    h.credentials = new JsonStore(join(dir, 'credentials.json'), {
      botToken: 'token', botId: 'bot', userId: 'owner', contextToken: 'same-token',
    });
    h.config = new JsonStore(join(dir, 'config.json'), { boundAt: 'already-bound' });
    await Promise.all([h.state.load(), h.credentials.load(), h.config.load()]);
    h.bridge = new Bridge({ state: h.state, credentials: h.credentials, config: h.config,
      desktopFactory: () => ({ validate: async () => ({ thread: thread('A') }),
        read: async id => ({ thread: thread(id), turns: structuredClone(h.histories.get(id) || []),
          page: { hasMore: false, nextCursor: null } }), close() {} }),
      weixin: { async sendText(credentials, message) {
        h.notices.push(structuredClone(message));
        await h.onSend(message, credentials);
        return { ret: 0 };
      } } });
    await h.bridge.init();
  };
  h.accept = async (...msgs) => h.bridge.acceptBatch({ msgs, get_updates_buf: `cursor-${msgs.at(-1)?.message_id}` });
  h.sendReplies = async (count, prefix = 'reply') => {
    for (let i = 1; i <= count; i++) await h.bridge.reply(`${prefix}-${i}`, `${prefix}正文${i}`);
    await h.bridge.sendPending();
  };
  t.after(async () => {
    h.bridge?.close();
    assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  });
  await h.restart();
  return h;
}

for (const mode of ['full', 'brief']) {
  test(`the tenth actual outgoing message shares command and multi-chat counts in ${mode} mode`, async t => {
    const h = await fixture(t);
    await h.bridge.register({ callerThreadId: 'A', pipePath: 'test-only' });
    await h.bridge.select('A');
    await h.bridge.setNotifications('B', true);
    await h.bridge.setNotificationMode(mode);
    await h.accept(incoming(1));
    await h.bridge.processInbound();
    await h.bridge.sendPending(); // The status reply is message 1.
    for (let i = 2; i <= 11; i++) {
      const id = i % 2 ? 'A' : 'B';
      h.histories.set(id, [{ id: `turn-${i}`, status: 'completed', items: [
        { type: 'agentMessage', phase: 'final_answer', text: `结果${i}` },
      ] }, ...(h.histories.get(id) || [])]);
      await h.bridge.observe();
      await h.bridge.sendPending();
    }
    assert.equal(h.notices.length, 11, 'reminder must not create a separate message');
    for (let i = 0; i < 11; i++) assert.equal(h.notices[i].text.endsWith(SUFFIX), i === 9);
    const tenth = h.state.read().notifications.find(n => n.turnId === 'turn-10');
    assert.equal(h.notices[9].text, tenth.text + SUFFIX);
    assert.equal(tenth.sentText, h.notices[9].text);
    assert.equal(tenth.status, 'accepted');
    assert.equal(h.state.read().selected, 'A');
    assert.deepEqual(h.bridge.status().subscriptions.map(c => c.number), [1, 2]);
    assert.equal(h.bridge.notificationMode(), mode);
    if (mode === 'brief') assert.doesNotMatch(h.notices[9].text, /结果10/);
    else assert.match(h.notices[9].text, /结果10/);
    assert.equal(h.state.read().pushWindow.count, 11);
  });
}

test('long full results retain their header and chat routes on messages 9, 10 and 11', async t => {
  const initial = structuredClone(INITIAL_STATE);
  initial.nextNumber = 65;
  const h = await fixture(t, initial);
  await h.bridge.register({ callerThreadId: 'A', pipePath: 'test-only' });
  await h.bridge.select('A');
  await h.bridge.setNotifications('B', true);
  await h.sendReplies(8);
  const header = '[#66 聊天B] 本轮已结束\n';
  const footer = '\n继续此聊天：#66 你的要求\n当前普通消息目标仍为 #65。';
  for (let ordinal = 9; ordinal <= 11; ordinal++) {
    h.histories.set('B', [{ id: `long-${ordinal}`, status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: '长结果😀'.repeat(600) },
    ] }, ...(h.histories.get('B') || [])]);
    await h.bridge.observe();
    const original = h.state.read().notifications.find(n => n.turnId === `long-${ordinal}`).text;
    assert.equal(Array.from(original).length, 1500);
    assert.ok(original.endsWith(footer));
    await h.bridge.sendPending();
    const actual = h.notices.at(-1).text;
    assert.ok(actual.startsWith(header));
    assert.equal(Array.from(actual).length, 1500);
    assert.doesNotMatch(actual, /\uFFFD/);
    if (ordinal === 10) {
      assert.ok(actual.endsWith(footer + SUFFIX), 'the reminder must follow both original routing hints');
      assert.equal(actual.split('继续此聊天：').length, 2);
      assert.equal(actual.split(REMINDER).length, 2);
    } else assert.equal(actual, original, 'other messages must remain byte-for-byte unchanged');
    assert.equal(h.state.read().notifications.find(n => n.turnId === `long-${ordinal}`).text, original);
    assert.equal(h.state.read().selected, 'A');
  }
});

test('a saved long full result keeps its original routes after restart, mode/selection changes and manual retry', async t => {
  const h = await fixture(t);
  await h.bridge.register({ callerThreadId: 'A', pipePath: 'test-only' });
  await h.bridge.select('A');
  await h.bridge.setNotifications('B', true);
  await h.accept(incoming(1));
  await h.sendReplies(9);
  h.histories.set('B', [{ id: 'saved-long', status: 'completed', items: [
    { type: 'agentMessage', phase: 'final_answer', text: '原结果😀'.repeat(600) },
  ] }]);
  await h.bridge.observe();
  const original = h.state.read().notifications.find(n => n.turnId === 'saved-long').text;
  const footer = '\n继续此聊天：#2 你的要求\n当前普通消息目标仍为 #1。';
  await h.bridge.setNotificationMode('brief');
  await h.bridge.select('B');
  await h.restart();
  h.onSend = async () => { throw new Error('timeout'); };
  await h.bridge.sendPending();
  assert.ok(h.notices.at(-1).text.endsWith(footer + SUFFIX));
  const record = h.state.read().notifications.find(n => n.turnId === 'saved-long');
  assert.equal(record.status, 'unknown');
  assert.equal(record.text, original);
  await h.accept(incoming(2));
  h.onSend = async () => {};
  await h.bridge.retryNotice(record.id);
  await h.bridge.sendPending();
  assert.equal(h.notices.at(-1).text, original, 'manual retry in the new window must retain the frozen full result');
  assert.equal(h.state.read().selected, 'B');
  assert.equal(h.bridge.notificationMode(), 'brief');
});

test('a tenth long subscription result preserves the unselected-target hint', async t => {
  const h = await fixture(t);
  await h.bridge.register({ callerThreadId: 'A', pipePath: 'test-only' });
  await h.bridge.setNotifications('A', true);
  await h.sendReplies(9);
  h.histories.set('A', [{ id: 'unselected-long', status: 'completed', items: [
    { type: 'agentMessage', phase: 'final_answer', text: '长结果'.repeat(800) },
  ] }]);
  await h.bridge.observe();
  await h.bridge.sendPending();
  assert.ok(h.notices.at(-1).text.endsWith('\n继续此聊天：#1 你的要求\n当前普通消息目标尚未选择。' + SUFFIX));
  assert.equal(Array.from(h.notices.at(-1).text).length, 1500);
  assert.equal(h.state.read().selected, null);
});

test('restart and duplicate, foreign or tokenless incoming messages retain the count; a new valid ID resets even with the same token', async t => {
  const h = await fixture(t);
  await h.accept(incoming(1));
  await h.sendReplies(9);
  await h.restart();
  await h.accept(incoming(1), incoming(2, { from_user_id: 'foreign' }), incoming(3, { context_token: '' }));
  await h.sendReplies(1, 'tenth');
  assert.equal(h.state.read().pushWindow.count, 10);
  assert.ok(h.notices.at(-1).text.endsWith(SUFFIX));
  await h.accept(incoming(4));
  await h.sendReplies(1, 'new-window');
  assert.equal(h.state.read().pushWindow.count, 1);
  assert.equal(h.state.read().pushWindow.contextMessageId, '4');
  assert.equal(h.notices.at(-1).text, 'new-window正文1');
});

test('unknown and rejected attempts conservatively count, never auto retry, and manual retry recomputes the reminder', async t => {
  const h = await fixture(t);
  await h.accept(incoming(1));
  h.onSend = async () => {
    if ([2, 10].includes(h.notices.length)) throw new Error('timeout');
    if (h.notices.length === 3) throw Object.assign(new Error('rejected'), { code: -2, category: 'rejected' });
  };
  await h.sendReplies(10);
  assert.equal(h.state.read().pushWindow.count, 10);
  assert.ok(h.notices[9].text.endsWith(SUFFIX));
  assert.equal(h.state.read().notifications.find(n => n.id === 'reply-10').status, 'unknown');
  await h.bridge.sendPending();
  assert.equal(h.notices.length, 10);
  await h.accept(incoming(2));
  h.onSend = async () => {};
  await h.bridge.retryNotice('reply-10');
  await h.bridge.sendPending();
  assert.equal(h.notices.at(-1).text, 'reply正文10');
  assert.equal(h.state.read().notifications.find(n => n.id === 'reply-10').sentText, undefined);
  assert.equal(h.state.read().pushWindow.count, 1);
  assert.equal(h.state.read().notifications.find(n => n.id === 'reply-2').status, 'unknown');
  assert.equal(h.state.read().notifications.find(n => n.id === 'reply-3').status, 'rejected');
  await h.sendReplies(9, 'after-retry');
  assert.ok(h.notices.at(-1).text.endsWith(SUFFIX));
  assert.equal(h.notices.at(-1).text.split(REMINDER).length, 2);
});

test('a late send acknowledgment cannot add to the new incoming message window', async t => {
  const h = await fixture(t);
  await h.accept(incoming(1));
  await h.sendReplies(9);
  let reached, release;
  const started = new Promise(r => { reached = r; });
  const gate = new Promise(r => { release = r; });
  h.onSend = async () => { reached(); await gate; };
  await h.bridge.reply('tenth', '第十条');
  const sending = h.bridge.sendPending();
  await started;
  await h.accept(incoming(2, { context_token: 'new-token' }));
  release();
  await sending;
  h.onSend = async () => {};
  await h.sendReplies(1, 'new-window');
  assert.equal(h.state.read().pushWindow.count, 1);
  assert.equal(h.state.read().pushWindow.contextMessageId, '2');
  assert.equal(h.notices.at(-1).contextToken, 'new-token');
  assert.equal(h.notices.at(-1).text, 'new-window正文1');
});

test('a queued send captures matching credentials and count before the incoming state write finishes', async t => {
  const h = await fixture(t);
  await h.accept(incoming(1));
  await h.sendReplies(9);
  await h.bridge.reply('racing', '当前正文');
  let reached, release;
  const started = new Promise(r => { reached = r; });
  const gate = new Promise(r => { release = r; });
  let blocked = false;
  h.beforeStateWrite = async s => { if (s.hold && !blocked) { blocked = true; reached(); await gate; } };
  const holding = h.state.update(s => { s.hold = true; });
  await started;
  const sending = h.bridge.sendPending();
  const accepting = h.accept(incoming(2, { context_token: 'new-token' }));
  try {
    const deadline = Date.now() + 2000;
    while (h.credentials.read().contextMessageId !== '2') {
      if (Date.now() > deadline) throw new Error('new credentials did not persist');
      await delay(5);
    }
  } finally { release(); }
  await Promise.all([holding, sending, accepting]);
  assert.equal(h.notices.at(-1).contextToken, 'new-token');
  assert.equal(h.notices.at(-1).text, '当前正文');
  assert.deepEqual(h.state.read().pushWindow, { contextMessageId: '2', count: 1 });
  await h.accept(incoming(2));
  await h.sendReplies(1, 'second');
  assert.equal(h.state.read().pushWindow.count, 2);
});

test('stopping before the remote call releases the reservation and preserves a pending tenth message', async t => {
  const h = await fixture(t);
  await h.sendReplies(9);
  await h.bridge.reply('tenth', '待发送正文');
  h.beforeStateWrite = async s => { if (s.notifications.find(n => n.id === 'tenth')?.status === 'sending') h.bridge.close(); };
  await h.bridge.sendPending();
  assert.equal(h.notices.length, 9);
  assert.equal(h.state.read().pushWindow.count, 9);
  assert.equal(h.state.read().notifications.at(-1).status, 'pending');
  h.beforeStateWrite = async () => {};
  await h.restart();
  await h.bridge.sendPending();
  assert.equal(h.notices.at(-1).text, '待发送正文' + SUFFIX);
});

test('failed send preparation publishes neither a count nor a remote call', async t => {
  const h = await fixture(t);
  await h.sendReplies(9);
  await h.bridge.reply('tenth', '待发送正文');
  h.beforeStateWrite = async s => {
    if (s.notifications.find(n => n.id === 'tenth')?.status === 'sending') throw new Error('disk failure');
  };
  await assert.rejects(h.bridge.sendPending(), /disk failure/);
  assert.equal(h.notices.length, 9);
  assert.equal(h.state.read().pushWindow.count, 9);
  assert.equal(h.state.read().notifications.at(-1).status, 'pending');
  h.beforeStateWrite = async () => {};
  await h.bridge.sendPending();
  assert.equal(h.notices.at(-1).text, '待发送正文' + SUFFIX);
});

test('legacy installation estimates its first count from the last received message and keeps it over restart', async t => {
  const state = structuredClone(INITIAL_STATE);
  state.inbound = [{ id: 'legacy', status: 'handled', receivedAt: '2026-01-01T01:00:00.000Z' }];
  state.notifications = Array.from({ length: 10 }, (_, i) => ({ id: `old-${i}`, kind: 'reply', status: 'accepted',
    text: '旧正文', attemptedAt: `2026-01-01T0${i ? 2 : 0}:00:00.000Z` }));
  const h = await fixture(t, state);
  await h.sendReplies(1);
  assert.equal(h.state.read().pushWindow.count, 10);
  assert.ok(h.notices.at(-1).text.endsWith(SUFFIX));
  await h.restart();
  await h.sendReplies(1, 'eleventh');
  assert.equal(h.state.read().pushWindow.count, 11);
  assert.equal(h.notices.at(-1).text, 'eleventh正文1');
});

test('the exact reminder follows a blank line within 1500 Unicode characters and is trimmed with old payloads', async t => {
  const h = await fixture(t);
  await h.sendReplies(9);
  const body = '😀'.repeat(1500);
  await h.bridge.reply('long-tenth', body);
  await h.bridge.sendPending();
  const sent = h.notices.at(-1).text;
  assert.ok(sent.endsWith(SUFFIX));
  assert.equal(Array.from(sent).length, 1500);
  assert.doesNotMatch(sent, /\uFFFD/);
  assert.equal(h.state.read().notifications.at(-1).text, body);
  await h.state.update(s => {
    for (let i = 0; i < 1000; i++) s.notifications.push({ id: `later-${i}`, status: 'accepted', text: '后续' });
  });
  await h.bridge.maintain();
  const trimmed = h.state.read().notifications.find(n => n.id === 'long-tenth');
  assert.equal(trimmed.text, undefined);
  assert.equal(trimmed.sentText, undefined);
});

test('trailing body whitespace does not introduce more than one blank line before the reminder', async t => {
  const h = await fixture(t);
  await h.sendReplies(9);
  await h.bridge.reply('tenth', '正文\n\n  ');
  await h.bridge.sendPending();
  assert.equal(h.notices.at(-1).text, '正文' + SUFFIX);
  assert.equal(h.state.read().notifications.at(-1).text, '正文\n\n  ');
});
