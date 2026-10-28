import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATE } from '../src/bridge.mjs';
import { parseCommand, ensureChat, byNumber, listText } from '../src/routing.mjs';
import { deliveryInTurn, finalText, truncate } from '../src/notifications.mjs';

const thread = (id, extra = {}) => ({ id, hostId: 'local', kind: 'codex', title: id, ...extra });

test('commands require complete matches and numbered messages do not imply selection', () => {
  assert.deepEqual(parseCommand(' 切换 #3 '), { type: 'select', number: 3 });
  assert.deepEqual(parseCommand('#3 请补充\n测试'), { type: 'message', number: 3, text: '请补充\n测试' });
  assert.deepEqual(parseCommand('通知 #3 关'), { type: 'notifications', number: 3, enabled: false });
  assert.deepEqual(parseCommand('列表 2'), { type: 'list', page: 2 });
  for (const text of ['切换 #3 然后继续', '通知 #3 开始', '列表 0', '帮助我检查']) {
    assert.deepEqual(parseCommand(text), { type: 'message', text });
  }
});

test('new-chat commands distinguish projectless and explicit projects and require a prompt', () => {
  for (const text of ['新建｜首条要求', '新建|首条要求', ' 新建 ｜ 首条要求 ']) {
    assert.deepEqual(parseCommand(text), { type: 'create', project: null, text: '首条要求' });
  }
  assert.deepEqual(parseCommand('新建 Demo ｜首条要求\n第二行'), {
    type: 'create', project: 'Demo', text: '首条要求\n第二行',
  });
  for (const text of ['新建', '新建 Demo', '新建｜', '新建|  ', '新建 Demo｜']) {
    assert.deepEqual(parseCommand(text), { type: 'invalid_create' });
  }
});

test('stable numbers survive title changes and are never reused for another chat', () => {
  const state = structuredClone(INITIAL_STATE);
  assert.equal(ensureChat(state, thread('A')).number, 1);
  assert.equal(ensureChat(state, thread('B')).number, 2);
  assert.equal(ensureChat(state, thread('A', { title: '新标题' })).number, 1);
  assert.equal(byNumber(state, 1).title, '新标题');
  delete state.chats.B;
  assert.equal(ensureChat(state, thread('C')).number, 3);
  assert.throws(() => byNumber(state, 2), /未知聊天/);
  assert.throws(() => byNumber(state, Number.MAX_SAFE_INTEGER + 1), /无效聊天编号/);
});

test('only unarchived local main chats can receive stable numbers', () => {
  const state = structuredClone(INITIAL_STATE);
  for (const extra of [{ hostId: 'remote' }, { kind: 'other' }, { isSubagent: true },
    { parentThreadId: 'parent' }, { archived: true }, { status: { type: 'archived' } }]) {
    assert.throws(() => ensureChat(state, thread('invalid', extra)), /本地主聊天/);
  }
  assert.equal(state.nextNumber, 1);
  assert.deepEqual(state.chats, {});
});

test('list pagination preserves stable numbers and marks selection and subscriptions independently', () => {
  const state = structuredClone(INITIAL_STATE);
  for (let i = 1; i <= 12; i++) ensureChat(state, thread(`chat-${i}`));
  state.selected = 'chat-11';
  state.chats['chat-12'].enabled = true;
  const page = listText(state, 2);
  assert.match(page, /聊天列表 2\/2/);
  assert.match(page, /#11 chat-11 \[当前目标\]/);
  assert.match(page, /#12 chat-12 \[通知开\]/);
  assert.doesNotMatch(page, /#1 chat-1\b/);
  assert.throws(() => listText(state, 3), /只有 2 页/);
  assert.equal(state.selected, 'chat-11');
});

test('delivery association requires an exact untruncated send-message output marker', () => {
  const item = { type: 'functionCallOutput', name: 'send_message_to_thread', output: { text: '<input>WECHAT_MESSAGE_ID=123\n要求</input>' } };
  assert.equal(deliveryInTurn({ items: [item] }, 'WECHAT_MESSAGE_ID=123'), true);
  for (const candidate of [
    { ...item, name: 'read_thread' },
    { ...item, type: 'agentMessage' },
    { ...item, output: { ...item.output, truncated: true } },
    { ...item, output: { text: '<input>WECHAT_MESSAGE_ID=1234\n要求</input>' } },
    { ...item, output: { text: '用户引用 WECHAT_MESSAGE_ID=123' } },
  ]) assert.equal(deliveryInTurn({ items: [candidate] }, 'WECHAT_MESSAGE_ID=123'), false);
});

test('result excerpts use final_answer, describe terminal state and respect Unicode limit', () => {
  const chat = { number: 3, title: '测试' };
  const completed = finalText(chat, { status: 'completed', items: [
    { type: 'agentMessage', phase: 'commentary', text: '过程文字' },
    { type: 'agentMessage', phase: 'final_answer', text: '[结果](https://example.com)\n' + '😀'.repeat(2000) },
  ] }, 7);
  assert.match(completed, /本轮已结束\n结果/);
  assert.doesNotMatch(completed, /过程文字|https:\/\//);
  assert.match(completed, /当前普通消息目标仍为 #7/);
  assert.equal(Array.from(completed).length <= 1500, true);
  for (const [status, label] of [['failed', '执行失败'], ['interrupted', '已中断']]) {
    const text = finalText(chat, { status, items: [] });
    assert.match(text, new RegExp(label));
    assert.match(text, /没有最终文字回复/);
    assert.doesNotMatch(text, /任务成功/);
  }
  assert.throws(() => finalText(chat, { status: 'inProgress', items: [] }), /not terminal/);
  assert.equal(Array.from(truncate('😀'.repeat(1600))).length, 1500);
});

test('result excerpts select the last nonempty final answer without earlier confirmations or trailing commentary', () => {
  const chat = { number: 3, title: '测试' };
  const text = finalText(chat, { status: 'completed', items: [
    { type: 'agentMessage', phase: 'final_answer', text: '中途确认'.repeat(2000) },
    { type: 'agentMessage', phase: 'final_answer', text: '旧结果' },
    { type: 'agentMessage', phase: 'final_answer', text: '  [实际结果](https://example.com) 😀  ' },
    { type: 'agentMessage', phase: 'final_answer', text: ' \n ' },
    { type: 'agentMessage', phase: 'final_answer' },
    { type: 'agentMessage', phase: 'final_answer', text: null },
    { type: 'agentMessage', phase: 'commentary', text: '末尾过程文字' },
  ] }, 7);
  assert.match(text, /本轮已结束\n实际结果 😀\n继续此聊天/);
  assert.doesNotMatch(text, /中途确认|旧结果|末尾过程文字|https:\/\/|已截断/);
  assert.equal(Array.from(text).length <= 1500, true);
});

test('all terminal states retain the no-final-text hint for empty or nonfinal messages', () => {
  for (const [status, label] of [['completed', '本轮已结束'], ['failed', '执行失败'], ['interrupted', '已中断']]) {
    const text = finalText({ number: 3, title: '测试' }, { status, items: [
      { type: 'agentMessage', phase: 'final_answer', text: '\n ' },
      { type: 'agentMessage', phase: 'commentary', text: '过程文字' },
    ] });
    assert.match(text, new RegExp(label));
    assert.match(text, /本轮没有最终文字回复，请回桌面查看实际状态。/);
    assert.doesNotMatch(text, /过程文字/);
  }
});
