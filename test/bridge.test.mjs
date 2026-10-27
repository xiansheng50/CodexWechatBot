import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Bridge, INITIAL_STATE } from '../src/bridge.mjs';
import { JsonStore } from '../src/state-store.mjs';

const thread = (id, extra = {}) => ({ id, hostId: 'local', kind: 'codex', title: `聊天${id}`, status: { type: 'idle' }, ...extra });
const turn = (id, status = 'completed', text = `结果${id}`, markers = []) => ({ id, status, items: [
  ...markers.map(marker => ({ type: 'functionCallOutput', name: 'send_message_to_thread', output: { text: `<input>${marker}\n要求</input>` } })),
  ...(text === null ? [] : [{ type: 'agentMessage', phase: 'final_answer', text }]),
] });
const raw = (id, text, extra = {}) => ({ message_id: String(id), from_user_id: 'owner', to_user_id: 'bot', message_type: 1,
  message_state: 2, context_token: 'fresh-context', item_list: [{ type: 1, text_item: { text } }], ...extra });
const resultNotices = h => h.state.read().notifications.filter(n => n.kind === 'result');

test('replayed old batches cannot replace a newer reply context', async t => {
  const h = await fixture(t);
  await h.receive(raw(1, '帮助', { context_token: 'older-context' }));
  await h.receive(raw(2, '帮助', { context_token: 'latest-context' }));
  await h.receive(raw(1, '帮助', { context_token: 'older-context' }));
  assert.equal(h.credentials.read().contextToken, 'latest-context');
  assert.equal(h.state.read().inbound.length, 2);
  assert.equal(h.state.read().inbound.some(m => Object.hasOwn(m, 'contextToken')), false);
});

test('an accepted submission without a readable matching turn becomes explicit unknown without resending', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  await h.receive(raw(1, '要求'));
  await h.dispatch();
  await h.state.update(s => { s.inbound[0].attemptedAt = new Date(Date.now() - 31_000).toISOString(); });
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'unknown');
  assert.equal(h.state.read().notifications.some(n => n.id === 'unknown:1'), true);
  await h.dispatch();
  assert.equal(h.sends.length, 1);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wechatbot-bridge-test-'));
  t.after(async () => {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const h = { directory, threads: new Map(['A', 'B'].map(id => [id, thread(id)])), histories: new Map(),
    reads: [], sends: [], notices: [], validations: [], onSend: async () => {}, onSendText: async () => {} };
  const desktopFactory = connection => ({
    async validate() { h.validations.push(connection); return { thread: h.threads.get(connection.callerThreadId) }; },
    async read(id, options = {}) {
      h.reads.push({ id, ...options });
      const source = h.threads.get(id);
      if (!source) throw Error('missing thread');
      const pages = h.histories.get(id) || [[]];
      const index = options.cursor ? Number(options.cursor) : 0;
      const turns = structuredClone(pages[index] || []);
      return { thread: structuredClone(source), turns: options.turnLimit ? turns.slice(0, options.turnLimit) : turns,
        page: { hasMore: index + 1 < pages.length, nextCursor: index + 1 < pages.length ? String(index + 1) : null } };
    },
    async list() { return { threads: [...h.threads.values()] }; },
    async send(id, prompt) { h.sends.push({ id, prompt }); await h.onSend(id, prompt); return { threadId: id }; },
    close() {},
  });
  h.restart = async () => {
    h.bridge?.close();
    h.state = new JsonStore(join(directory, 'state.json'), INITIAL_STATE);
    h.credentials = new JsonStore(join(directory, 'credentials.json'), { botToken: 'bot-token', botId: 'bot', userId: 'owner',
      contextToken: 'context', contextVersion: 1, baseUrl: 'https://ilinkai.weixin.qq.com' });
    h.config = new JsonStore(join(directory, 'config.json'), { boundAt: 'already-bound' });
    await Promise.all([h.state.load(), h.credentials.load(), h.config.load()]);
    h.bridge = new Bridge({ state: h.state, credentials: h.credentials, config: h.config, desktopFactory,
      weixin: { async sendText(credentials, message) { h.notices.push({ credentials, ...message }); await h.onSendText(message); return { ret: 0 }; } } });
    await h.bridge.init();
  };
  h.receive = async (...messages) => {
    await h.bridge.acceptBatch({ msgs: messages, get_updates_buf: `cursor-${messages.at(-1)?.message_id || 'empty'}` });
    await h.bridge.processInbound();
  };
  h.dispatch = () => Promise.all(h.bridge.dispatchReady());
  await h.restart();
  await h.bridge.register({ callerThreadId: 'A', hostId: 'local', pipePath: 'fake-endpoint' });
  t.after(() => h.bridge.close());
  return h;
}

test('selection stays explicit through numbered messages, subscriptions and result notifications', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  await h.bridge.setNotifications('B', true);
  await h.receive(raw(1, '#2 单次要求'), raw(2, '普通要求'));
  assert.deepEqual(h.state.read().inbound.map(m => m.target), ['B', 'A']);
  await h.dispatch();
  assert.deepEqual(h.sends.map(m => m.id), ['B', 'A']);
  h.histories.set('B', [[turn('B1', 'completed', 'B结果', ['WECHAT_MESSAGE_ID=1'])]]);
  await h.bridge.observe();
  assert.equal(h.state.read().selected, 'A');
  assert.equal(resultNotices(h).length, 1);
  assert.match(resultNotices(h)[0].text, /当前普通消息目标仍为 #1/);
});

test('targets are frozen in reception order before later selection commands and restart', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  await h.bridge.chatCurrent('B');
  await h.receive(raw(1, '第一条'), raw(2, '切换 #2'), raw(3, '第二条'));
  assert.deepEqual(h.state.read().inbound.map(m => [m.status, m.target]), [['ready', 'A'], ['handled', undefined], ['ready', 'B']]);
  await h.restart();
  assert.equal(h.bridge.status().desktop, 'connected');
  assert.equal(h.state.read().selected, 'B');
  await h.dispatch();
  assert.deepEqual(h.sends.map(m => m.id).sort(), ['A', 'B']);
});

test('no selection, unknown number, foreign sender and media never submit desktop writes', async t => {
  const h = await fixture(t);
  await h.receive(raw(1, '没有目标'), raw(2, '#99 不存在'), raw(3, '外人', { from_user_id: 'other' }),
    raw(4, '', { item_list: [{ type: 2, image_item: {} }] }));
  await h.dispatch();
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.state.read().inbound.map(m => m.id), ['1', '2', '4']);
  assert.match(h.state.read().notifications.find(n => n.id === 'reply:1').text, /尚未选择聊天/);
  assert.match(h.state.read().notifications.find(n => n.id === 'reply:2').text, /未知聊天/);
  assert.match(h.state.read().notifications.find(n => n.id === 'reply:4').text, /仅支持文字/);
});

test('known archived targets produce an explicit rejection instead of leaving a request queued forever', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  h.threads.set('A', thread('A', { archived: true }));
  await h.receive(raw(1, '已归档聊天的要求'));
  await h.dispatch();
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.read().inbound[0].status, 'rejected');
  assert.match(h.state.read().notifications.find(n => n.id === 'reply:1')?.text || '', /归档/);
  assert.equal(h.state.read().selected, 'A', 'rejection must not choose another chat');
});

test('duplicate batches and restart retain IDs without resubmitting accepted requirements', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  const message = raw('18446744073709551615', '执行一次');
  await h.receive(message);
  await h.dispatch();
  await h.restart();
  await h.receive(message);
  await h.dispatch();
  assert.equal(h.sends.length, 1);
  assert.equal(h.state.read().inbound.length, 1);
  assert.equal(h.state.read().cursor, 'cursor-18446744073709551615');
  assert.equal(h.state.read().chats.A.number, 1);
});

test('multiple busy-chat additions are submitted without waiting for a terminal turn and merge with subscription', async t => {
  const h = await fixture(t);
  h.histories.set('A', [[turn('busy', 'inProgress', '已经出现的最终文本')]]);
  await h.bridge.setNotifications('A', true);
  await h.bridge.select('A');
  await h.receive(raw(1, '追加一'), raw(2, '追加二'));
  await h.dispatch();
  assert.equal(h.sends.length, 2);
  h.histories.set('A', [[turn('busy', 'inProgress', '已经出现的最终文本', ['WECHAT_MESSAGE_ID=1', 'WECHAT_MESSAGE_ID=2'])]]);
  await h.bridge.observe();
  assert.deepEqual(h.state.read().inbound.map(m => [m.status, m.turnId]), [['confirmed', 'busy'], ['confirmed', 'busy']]);
  assert.equal(resultNotices(h).length, 0, 'final_answer alone must not end the turn');
  h.histories.set('A', [[turn('busy', 'completed', '实际结束结果', ['WECHAT_MESSAGE_ID=1', 'WECHAT_MESSAGE_ID=2'])]]);
  await h.bridge.observe();
  await h.bridge.observe();
  assert.equal(resultNotices(h).length, 1);
  assert.equal(resultNotices(h)[0].requested, true);
  assert.match(resultNotices(h)[0].text, /实际结束结果/);
  assert.deepEqual(h.state.read().inbound.map(m => m.status), ['completed', 'completed']);
  await h.bridge.sendPending();
  assert.equal(h.notices.filter(n => n.text.includes('实际结束结果')).length, 1);
});

test('submission marker associates with actual new turn instead of previous completed answer', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  h.histories.set('A', [[turn('old', 'completed', '上一轮答案')]]);
  await h.receive(raw(1, '下一轮要求'));
  await h.dispatch();
  h.histories.set('A', [[turn('new', 'inProgress', null, ['WECHAT_MESSAGE_ID=1']), turn('old', 'completed', '上一轮答案')]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].turnId, 'new');
  assert.equal(resultNotices(h).length, 0);
  h.histories.set('A', [[turn('new', 'completed', '本轮答案', ['WECHAT_MESSAGE_ID=1']), turn('old')]]);
  await h.bridge.observe();
  assert.equal(resultNotices(h)[0].turnId, 'new');
  assert.doesNotMatch(resultNotices(h)[0].text, /上一轮答案/);
});

test('subscriptions skip old history, preserve their baseline on repeated enable and survive restart', async t => {
  const h = await fixture(t);
  h.histories.set('A', [[turn('old')]]);
  await h.bridge.setNotifications('A', true);
  const enabledAt = h.state.read().chats.A.enabledAt;
  h.histories.set('A', [[turn('new'), turn('old')]]);
  await h.bridge.setNotifications('A', true);
  assert.equal(h.state.read().chats.A.enabledAt, enabledAt);
  assert.equal(h.state.read().chats.A.observation.anchor, 'old');
  await h.restart();
  await h.bridge.observe();
  assert.deepEqual(resultNotices(h).map(n => n.turnId), ['new']);
  await h.bridge.sendPending();
  await h.restart();
  await h.bridge.observe();
  await h.bridge.sendPending();
  assert.equal(h.notices.filter(n => n.text.includes('结果new')).length, 1);
});

test('failed and interrupted turns without final text report actual terminal state per chat', async t => {
  const h = await fixture(t);
  await h.bridge.setNotifications('A', true);
  await h.bridge.setNotifications('B', true);
  h.histories.set('A', [[turn('failed', 'failed', null)]]);
  h.histories.set('B', [[turn('stopped', 'interrupted', null)]]);
  await h.bridge.observe();
  const notices = resultNotices(h);
  assert.equal(notices.length, 2);
  assert.match(notices.find(n => n.threadId === 'A').text, /执行失败/);
  assert.match(notices.find(n => n.threadId === 'B').text, /已中断/);
  for (const notice of notices) {
    assert.match(notice.text, /没有最终文字回复/);
    assert.doesNotMatch(notice.text, /任务成功/);
  }
});

test('disabling notifications cancels subscription-only pending results and preserves requested results', async t => {
  const h = await fixture(t);
  await h.bridge.setNotifications('A', true);
  h.histories.set('A', [[turn('desktop-only')]]);
  await h.bridge.observe();
  await h.bridge.select('A');
  await h.receive(raw(1, '微信要求'));
  await h.dispatch();
  h.histories.set('A', [[turn('requested', 'completed', '微信结果', ['WECHAT_MESSAGE_ID=1']), turn('desktop-only')]]);
  await h.bridge.observe();
  await h.bridge.setNotifications('A', false);
  assert.equal(resultNotices(h).find(n => n.turnId === 'desktop-only').status, 'cancelled');
  assert.equal(resultNotices(h).find(n => n.turnId === 'requested').status, 'pending');
  await h.bridge.sendPending();
  assert.equal(h.notices.filter(n => n.text.includes('结果desktop-only')).length, 0);
  assert.equal(h.notices.filter(n => n.text.includes('微信结果')).length, 1);
  h.histories.set('A', [[turn('after-off'), turn('requested'), turn('desktop-only')]]);
  await h.bridge.observe();
  assert.equal(resultNotices(h).length, 2);
});

test('observation pages to both its anchor and an older unfinished subscribed turn', async t => {
  const h = await fixture(t);
  h.histories.set('A', [[turn('older-active', 'inProgress', null)]]);
  await h.bridge.setNotifications('A', true);
  h.histories.set('A', [[turn('middle')], [turn('older-active', 'inProgress', null)]]);
  await h.bridge.observe();
  assert.deepEqual(h.state.read().chats.A.observation, { anchor: 'middle', pending: ['older-active'] });
  h.histories.set('A', [[turn('new')], [turn('middle')], [turn('older-active', 'completed', '迟到结果')]]);
  h.reads.length = 0;
  await h.bridge.observe();
  assert.deepEqual(h.reads.map(r => r.cursor), [undefined, '1', '2']);
  assert.deepEqual(resultNotices(h).map(n => n.turnId).sort(), ['middle', 'new', 'older-active']);
  assert.deepEqual(h.state.read().chats.A.observation.pending, []);
});

test('confirmed requested turn outside the latest page is followed until it terminates', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  await h.receive(raw(1, '微信要求'));
  await h.dispatch();
  h.histories.set('A', [[turn('requested', 'inProgress', null, ['WECHAT_MESSAGE_ID=1'])]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'confirmed');
  h.histories.set('A', [[turn('newer-unrelated')], [turn('requested', 'completed', '旧轮最终结果', ['WECHAT_MESSAGE_ID=1'])]]);
  h.reads.length = 0;
  await h.bridge.observe();
  assert.deepEqual(h.reads.map(r => r.cursor), [undefined, '1']);
  assert.equal(h.state.read().inbound[0].status, 'completed');
  assert.deepEqual(resultNotices(h).map(n => n.turnId), ['requested']);
});

test('missing observation anchor reports a gap and never guesses a full-history replay', async t => {
  const h = await fixture(t);
  h.histories.set('A', [[turn('anchor')]]);
  await h.bridge.setNotifications('A', true);
  h.histories.set('A', [[turn('unrelated-old')]]);
  await h.bridge.observe();
  assert.match(h.state.read().chats.A.observationGap, /无法找到上次观察位置/);
  assert.equal(resultNotices(h).length, 0);
  assert.equal(h.state.read().notifications.filter(n => n.id.startsWith('gap:')).length, 1);
});

test('unknown desktop submission is never resent and can be recovered by read-only marker lookup', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  h.onSend = async () => { throw Error('connection lost after write'); };
  await h.receive(raw(1, '仅执行一次'));
  await h.dispatch();
  assert.equal(h.state.read().inbound[0].status, 'unknown');
  await h.restart();
  await h.receive(raw(1, '仅执行一次'));
  await h.dispatch();
  assert.equal(h.sends.length, 1);
  h.histories.set('A', [[turn('actual', 'completed', '实际执行结果', ['WECHAT_MESSAGE_ID=1'])]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'completed');
  assert.equal(resultNotices(h)[0].turnId, 'actual');
});

test('restart changes in-flight writes to unknown rather than replaying them', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  await h.receive(raw(1, '写入途中退出'));
  await h.state.update(s => {
    Object.assign(s.inbound[0], { status: 'submitting', marker: 'WECHAT_MESSAGE_ID=1' });
    s.notifications.push({ id: 'during-send', kind: 'reply', text: '可能已送达', status: 'sending', clientId: 'preserved-client-id' });
  });
  await h.restart();
  await h.dispatch();
  await h.bridge.sendPending();
  assert.equal(h.state.read().inbound[0].status, 'unknown');
  assert.equal(h.state.read().notifications[0].status, 'unknown');
  assert.equal(h.state.read().notifications[0].clientId, 'preserved-client-id');
  assert.equal(h.sends.length, 0);
  assert.equal(h.notices.length, 0);
});

test('unknown send results stay unknown across polls and restart; missing context stays pending', async t => {
  const h = await fixture(t);
  await h.bridge.reply('unknown-send', '结果');
  await h.credentials.update(c => { delete c.contextToken; });
  await h.bridge.sendPending();
  assert.equal(h.state.read().notifications[0].status, 'pending');
  assert.equal(h.notices.length, 0);
  await h.credentials.update(c => { c.contextToken = 'context'; });
  h.onSendText = async () => { throw Error('timeout'); };
  await h.bridge.sendPending();
  const notice = h.state.read().notifications[0];
  assert.equal(notice.status, 'unknown');
  assert.ok(notice.clientId);
  await h.bridge.sendPending();
  await h.restart();
  await h.bridge.sendPending();
  assert.equal(h.notices.length, 1);
  assert.equal(h.state.read().notifications[0].clientId, notice.clientId);
});

test('explicit rejections never auto retry after refreshed owner context; manual retry remains available', async t => {
  const h = await fixture(t);
  await h.bridge.reply('rejected-send', '结果');
  h.onSendText = async () => { throw Object.assign(Error('rejected'), { category: 'rejected', code: 123 }); };
  await h.bridge.sendPending();
  assert.equal(h.state.read().notifications[0].status, 'rejected');
  await h.receive(raw(1, '帮助', { context_token: 'refreshed-context' }));
  await h.bridge.sendPending();
  await h.restart();
  await h.bridge.sendPending();
  assert.equal(h.notices.filter(n => n.text === '结果').length, 1);
  h.onSendText = async () => {};
  await h.bridge.retryNotice('rejected-send');
  await h.bridge.sendPending();
  assert.equal(h.notices.filter(n => n.text === '结果').length, 2);
  assert.equal(h.state.read().notifications.find(n => n.id === 'rejected-send').status, 'accepted');
});

test('legacy context coordination migrates to manual review without losing notices or resending', async t => {
  const h = await fixture(t);
  await h.state.update(s => s.notifications.push({ id: 'legacy', kind: 'reply', text: '旧通知',
    status: 'awaiting_context', contextVersion: 1, clientId: 'legacy-client' }));
  await h.credentials.update(c => { c.contextVersion = 9; });
  await h.restart();
  await h.receive(raw(1, '帮助'));
  await h.bridge.sendPending();
  const legacy = h.state.read().notifications.find(n => n.id === 'legacy');
  assert.equal(legacy.status, 'rejected');
  assert.equal(legacy.clientId, 'legacy-client');
  assert.equal(Object.hasOwn(legacy, 'contextVersion'), false);
  assert.equal(Object.hasOwn(h.credentials.read(), 'contextVersion'), false);
  assert.equal(h.notices.some(n => n.text === '旧通知'), false);
  await h.bridge.retryNotice('legacy');
  await h.bridge.sendPending();
  assert.equal(h.state.read().notifications.find(n => n.id === 'legacy').status, 'accepted');
});

test('observation reads tool outputs only until a requested turn is located', async t => {
  const h = await fixture(t);
  await h.bridge.select('A');
  await h.bridge.setNotifications('A', true);
  h.histories.set('A', [[turn('subscribed')]]);
  const read = h.bridge.desktop.read.bind(h.bridge.desktop);
  h.bridge.desktop.read = (id, options) => {
    // Real Desktop refuses a single turn with oversized tool outputs.
    if (options.includeOutputs !== false && h.state.read().inbound.every(m => m.turnId || m.status !== 'submitted')) throw Error('Tool response exceeds the size limit');
    return read(id, options);
  };
  await h.bridge.observe();
  assert.equal(resultNotices(h).length, 1);
  await h.receive(raw(1, '要求'));
  await h.dispatch();
  h.histories.set('A', [[turn('requested', 'inProgress', null, ['WECHAT_MESSAGE_ID=1'])], [turn('subscribed')]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].turnId, 'requested');
  assert.equal(h.reads.at(-1).includeOutputs, true);
  h.histories.set('A', [[turn('requested', 'completed', '最新最终结果')], [turn('subscribed')]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'completed');
  assert.equal(h.reads.at(-1).includeOutputs, false);
  assert.equal(resultNotices(h).length, 2);
  assert.match(resultNotices(h).at(-1).text, /最新最终结果/);
});
