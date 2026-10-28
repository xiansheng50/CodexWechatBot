import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Bridge, INITIAL_STATE } from '../src/bridge.mjs';
import { JsonStore } from '../src/state-store.mjs';

const project = (extra = {}) => ({ projectId: 'project-demo', projectKind: 'local', label: '示例项目',
  path: 'D:\\Projects\\Demo', hostId: 'local', isGitRepository: true, ...extra });
const thread = (id, extra = {}) => ({ id, hostId: 'local', kind: 'codex', title: `聊天${id}`,
  status: { type: 'idle' }, ...extra });
const raw = (id, text) => ({ message_id: String(id), from_user_id: 'owner', to_user_id: 'bot',
  message_type: 1, message_state: 2, context_token: 'fresh-context',
  item_list: [{ type: 1, text_item: { text } }] });
const creationItem = marker => ({ type: 'functionCallOutput', name: 'create_thread', namespace: 'codex_app',
  output: { text: `<codex_delegation>\n  <source_thread_id>A</source_thread_id>\n  <input>${marker}\n\n首条要求</input>\n</codex_delegation>`, truncated: false } });
const initialTurn = (id, marker, status = 'inProgress', result = null) => ({ id, status, items: [
  creationItem(marker),
  ...(result === null ? [] : [{ type: 'agentMessage', phase: 'final_answer', text: result }]),
] });
const results = h => h.state.read().notifications.filter(n => n.kind === 'result');
const createdAcks = h => h.state.read().notifications.filter(n => n.kind === 'reply' && /已创建/.test(n.text));
const creationModes = [
  { label: 'specified project', command: '新建 示例项目｜首条要求', projectId: 'project-demo' },
  { label: 'projectless', command: '新建｜首条要求', projectId: null },
];
function testCreationModes(name, run) {
  for (const mode of creationModes) test(`${name} (${mode.label})`, t => run(t, mode));
}

async function fixture(t, { unsupported = false, noProjectListing = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wechatbot-new-chat-test-'));
  const h = { directory, projects: [project()], threads: new Map([['A', thread('A')]]), histories: new Map(),
    reads: [], creates: [], sends: [], notices: [], onCreate: async () => ({ threadId: 'NEW', hostId: 'local' }) };
  t.after(async () => {
    h.bridge?.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const desktopFactory = () => ({
    async validate() { return { thread: h.threads.get('A') }; },
    ...(noProjectListing ? {} : { async projects() { return { projects: structuredClone(h.projects) }; } }),
    ...(unsupported ? {} : { async create(projectId, prompt) {
      h.creates.push({ projectId, prompt });
      const response = await h.onCreate(projectId, prompt);
      if (response?.threadId) h.threads.set(response.threadId, thread(response.threadId));
      return response;
    } }),
    async read(id, options = {}) {
      h.reads.push({ id, ...options });
      assert.equal(typeof id, 'string', 'observer must never read an unknown target');
      assert.ok(h.threads.has(id), `unknown fake thread ${id}`);
      const pages = h.histories.get(id) || [[]];
      const index = options.cursor ? Number(options.cursor) : 0;
      const turns = structuredClone(pages[index] || []);
      return { thread: structuredClone(h.threads.get(id)), turns: options.turnLimit ? turns.slice(0, options.turnLimit) : turns,
        page: { hasMore: index + 1 < pages.length, nextCursor: index + 1 < pages.length ? String(index + 1) : null } };
    },
    async send(id, prompt) { h.sends.push({ id, prompt }); return { threadId: id }; },
    async list() { return { threads: [...h.threads.values()] }; },
    close() {},
  });
  h.restart = async () => {
    h.bridge?.close();
    h.state = new JsonStore(join(directory, 'state.json'), INITIAL_STATE);
    h.credentials = new JsonStore(join(directory, 'credentials.json'), { botToken: 'fake-token', botId: 'bot',
      userId: 'owner', contextToken: 'fake-context', contextVersion: 1 });
    h.config = new JsonStore(join(directory, 'config.json'), { boundAt: 'already-bound' });
    await Promise.all([h.state.load(), h.credentials.load(), h.config.load()]);
    h.bridge = new Bridge({ state: h.state, credentials: h.credentials, config: h.config, desktopFactory,
      weixin: { async sendText(credentials, message) { h.notices.push(message); return { ret: 0 }; } } });
    await h.bridge.init();
  };
  h.receive = async (...messages) => {
    await h.bridge.acceptBatch({ msgs: messages, get_updates_buf: `cursor-${messages.at(-1)?.message_id || 'empty'}` });
    await h.bridge.processInbound();
  };
  h.dispatch = () => Promise.all(h.bridge.dispatchReady());
  await h.restart();
  await h.bridge.register({ callerThreadId: 'A', hostId: 'local', pipePath: 'fake-endpoint' });
  await h.bridge.select('A');
  return h;
}

test('create persists intent before the external write and selects and subscribes its stable numbered chat', async t => {
  const h = await fixture(t);
  await h.bridge.setNotifications('A', true);
  const previousObservation = h.state.read().chats.A;
  const readsBeforeCreate = h.reads.length;
  const beforeCreate = Date.now();
  h.onCreate = async (projectId, prompt) => {
    const saved = JSON.parse(await readFile(join(h.directory, 'state.json'), 'utf8'));
    const row = saved.inbound.find(m => m.id === '1');
    assert.equal(row.operation, 'create');
    assert.equal(row.status, 'submitting');
    assert.equal(row.projectId, 'project-demo');
    assert.equal(row.prompt, '首条要求');
    assert.equal(row.marker, 'WECHAT_MESSAGE_ID=1');
    assert.equal(saved.selected, 'A');
    assert.equal(results(h).length, 0);
    assert.equal(prompt, 'WECHAT_MESSAGE_ID=1\n\n首条要求');
    return { threadId: 'NEW', hostId: 'local' };
  };
  await h.receive(raw(1, '新建 示例项目｜首条要求'));
  const saved = h.state.read();
  assert.deepEqual(h.creates, [{ projectId: 'project-demo', prompt: 'WECHAT_MESSAGE_ID=1\n\n首条要求' }]);
  assert.equal(saved.inbound[0].status, 'submitted');
  assert.equal(saved.inbound[0].target, 'NEW');
  assert.equal(saved.selected, 'NEW');
  assert.equal(saved.chats.NEW.number, 2);
  assert.match(saved.chats.NEW.title, /新聊天.*示例项目/);
  assert.equal(saved.chats.NEW.enabled, true);
  assert.deepEqual(saved.chats.NEW.observation, { anchor: null, pending: [] });
  assert.ok(Date.parse(saved.chats.NEW.enabledAt) >= beforeCreate);
  assert.ok(Date.parse(saved.chats.NEW.enabledAt) <= Date.now());
  assert.equal(h.reads.length, readsBeforeCreate, 'creation enables notification without an extra desktop read');
  assert.deepEqual(saved.chats.A, { ...previousObservation, enabled: false });
  assert.equal(createdAcks(h).length, 1);
  assert.equal(results(h).length, 0, 'create acceptance is not a completed turn');
});

test('projectless creation persists intent and selects and subscribes the new chat without project listing', async t => {
  for (const command of ['新建｜首条要求', '新建 | 首条要求']) {
    await t.test(command, async t => {
      const h = await fixture(t, { noProjectListing: true });
      h.projects = [];
      await h.bridge.setNotifications('A', true);
      const previousObservation = h.state.read().chats.A;
      const readsBeforeCreate = h.reads.length;
      const beforeCreate = Date.now();
      h.onCreate = async (projectId, prompt) => {
        const saved = JSON.parse(await readFile(join(h.directory, 'state.json'), 'utf8'));
        const row = saved.inbound[0];
        assert.equal(row.operation, 'create');
        assert.equal(row.status, 'submitting');
        assert.equal(row.projectId, null);
        assert.equal(row.projectLabel, '无项目');
        assert.equal(row.prompt, '首条要求');
        assert.equal(saved.selected, 'A');
        assert.equal(projectId, null);
        assert.equal(prompt, 'WECHAT_MESSAGE_ID=1\n\n首条要求');
        return { threadId: 'NEW', hostId: 'local' };
      };
      await h.receive(raw(1, command));
      const saved = h.state.read();
      assert.deepEqual(h.creates, [{ projectId: null, prompt: 'WECHAT_MESSAGE_ID=1\n\n首条要求' }]);
      assert.equal(saved.inbound[0].status, 'submitted');
      assert.equal(saved.inbound[0].target, 'NEW');
      assert.equal(saved.selected, 'NEW');
      assert.equal(saved.chats.NEW.number, 2);
      assert.match(saved.chats.NEW.title, /新聊天.*无项目/);
      assert.equal(saved.chats.NEW.enabled, true);
      assert.deepEqual(saved.chats.NEW.observation, { anchor: null, pending: [] });
      assert.ok(Date.parse(saved.chats.NEW.enabledAt) >= beforeCreate);
      assert.ok(Date.parse(saved.chats.NEW.enabledAt) <= Date.now());
      assert.equal(h.reads.length, readsBeforeCreate, 'creation enables notification without an extra desktop read');
      assert.deepEqual(saved.chats.A, { ...previousObservation, enabled: false });
      assert.equal(createdAcks(h).length, 1);
      assert.equal(results(h).length, 0);
    });
  }
});

testCreationModes('successful creation cancels previous subscription notices and preserves requested results', async (t, mode) => {
  const h = await fixture(t);
  await h.state.update(s => {
    s.notifications.push(
      { id: 'old-subscription', kind: 'result', threadId: 'A', turnId: 'old-desktop', requested: false, status: 'pending', text: '桌面结果' },
      { id: 'old-requested', kind: 'result', threadId: 'A', turnId: 'old-wechat', requested: true, status: 'pending', text: '微信要求的结果' });
  });
  await h.receive(raw(1, mode.command));
  assert.equal(h.state.read().notifications.find(n => n.id === 'old-subscription').status, 'cancelled');
  assert.equal(h.state.read().notifications.find(n => n.id === 'old-requested').status, 'pending');
  await h.bridge.sendPending();
  assert.equal(h.notices.filter(n => n.text === '微信要求的结果').length, 1);
  assert.equal(h.notices.some(n => n.text === '桌面结果'), false);
});

testCreationModes('ordinary messages bind in reception order around creation and use the minimal marker header', async (t, mode) => {
  const h = await fixture(t);
  await h.receive(raw(1, '创建前'), raw(2, mode.command), raw(3, '创建后'));
  assert.deepEqual(h.state.read().inbound.map(m => m.target), ['A', 'NEW', 'NEW']);
  await h.dispatch();
  assert.deepEqual(h.sends, [{ id: 'A', prompt: 'WECHAT_MESSAGE_ID=1\n\n创建前' },
    { id: 'NEW', prompt: 'WECHAT_MESSAGE_ID=3\n\n创建后' }]);
  assert.equal(h.creates.length, 1);
  assert.equal(h.state.read().selected, 'NEW');
});

test('creation matches exact local project labels, directory basenames, IDs and full paths', async t => {
  for (const selector of ['示例项目', 'Demo', 'project-demo', 'D:\\Projects\\Demo']) {
    await t.test(selector, async t => {
      const h = await fixture(t);
      await h.receive(raw(1, `新建 ${selector}｜首条要求`));
      assert.equal(h.creates.length, 1);
      assert.equal(h.creates[0].projectId, 'project-demo');
    });
  }
});

test('project listing paginates without creating or changing the selected chat', async t => {
  const h = await fixture(t);
  h.projects = Array.from({ length: 11 }, (_, index) => project({ projectId: `p${index + 1}`, label: `项目${index + 1}`,
    path: `D:\\Projects\\Demo${index + 1}` }));
  await h.receive(raw(1, '项目'), raw(2, '项目 2'));
  const replies = h.state.read().notifications.map(n => n.text);
  assert.match(replies[0], /项目1/);
  assert.doesNotMatch(replies[0], /项目11/);
  assert.match(replies[1], /项目11/);
  assert.equal(h.creates.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.read().selected, 'A');
});

test('unknown, ambiguous and remote project selectors reject without falling through to the old target', async t => {
  for (const scenario of ['unknown', 'ambiguous', 'remote']) {
    await t.test(scenario, async t => {
      const h = await fixture(t);
      const previousChat = h.state.read().chats.A;
      if (scenario === 'ambiguous') h.projects.push(project({ projectId: 'another', path: 'D:\\Other\\Demo' }));
      if (scenario === 'remote') h.projects = [project({ projectKind: 'remote', hostId: 'remote-host' })];
      await h.receive(raw(1, `新建 ${scenario === 'unknown' ? 'Dem' : '示例项目'}｜首条要求`));
      await h.dispatch();
      assert.equal(h.creates.length, 0);
      assert.equal(h.sends.length, 0);
      assert.equal(h.state.read().selected, 'A');
      assert.equal(h.state.read().inbound[0].status, 'rejected');
      assert.deepEqual(h.state.read().chats.A, previousChat);
      assert.ok(h.state.read().notifications.some(n => /未执行/.test(n.text)));
    });
  }
});

test('malformed new-chat commands never become tasks in the previous target', async t => {
  const h = await fixture(t);
  await h.receive(...['新建', '新建 示例项目', '新建 示例项目｜', '新建｜', '新建 | '].map((text, i) => raw(i + 1, text)));
  await h.dispatch();
  assert.equal(h.creates.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.read().selected, 'A');
  assert.ok(h.state.read().inbound.every(m => m.status === 'rejected'));
});

testCreationModes('unsupported creation preserves the old target and reports rejection', async (t, mode) => {
  const h = await fixture(t, { unsupported: true });
  const previousChat = h.state.read().chats.A;
  await h.receive(raw(1, mode.command));
  await h.dispatch();
  assert.equal(h.state.read().inbound[0].status, 'rejected');
  assert.equal(h.state.read().selected, 'A');
  assert.equal(h.sends.length, 0);
  assert.match(h.state.read().notifications[0].text, /未执行/);
  assert.deepEqual(h.state.read().chats.A, previousChat);
});

testCreationModes('duplicate creation batches and restart preserve a single external create and stable chat number', async (t, mode) => {
  const h = await fixture(t);
  const message = raw('18446744073709551615', mode.command);
  await h.receive(message, message);
  const number = h.state.read().chats.NEW?.number;
  await h.restart();
  await h.receive(message);
  await h.dispatch();
  assert.equal(h.creates.length, 1);
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.read().inbound.length, 1);
  assert.equal(h.state.read().selected, 'NEW');
  assert.equal(h.state.read().chats.NEW.number, number);
  assert.equal(createdAcks(h).length, 1);
});

testCreationModes('actual create_thread delegation associates the created turn and returns one result only after it ends', async (t, mode) => {
  const h = await fixture(t);
  await h.receive(raw(1, mode.command));
  h.histories.set('NEW', [[initialTurn('actual-turn', 'WECHAT_MESSAGE_ID=1', 'inProgress', '尚未结束的文本')]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'confirmed');
  assert.equal(h.state.read().inbound[0].turnId, 'actual-turn');
  assert.equal(results(h).length, 0);
  h.histories.set('NEW', [[initialTurn('actual-turn', 'WECHAT_MESSAGE_ID=1', 'completed', '真正最终结果')]]);
  await h.bridge.observe();
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'completed');
  assert.equal(createdAcks(h).length, 1);
  assert.equal(h.state.read().notifications.filter(n => n.kind === 'reply').length, 1, 'creation and observation must not send two acknowledgements');
  assert.equal(results(h).length, 1);
  assert.equal(results(h)[0].requested, true);
  assert.equal(results(h)[0].turnId, 'actual-turn');
  assert.match(results(h)[0].text, /真正最终结果/);
  await h.bridge.sendPending();
  await h.bridge.sendPending();
  assert.equal(h.notices.length, 2);
});

testCreationModes('global brief mode applies to new-chat confirmation and first result', async (t, mode) => {
  const h = await fixture(t);
  await h.bridge.setNotificationMode('brief');
  await h.receive(raw(1, mode.command));
  assert.equal(h.bridge.notificationMode(), 'brief');
  assert.match(createdAcks(h)[0].text, /本轮结束后发送通知/);
  assert.doesNotMatch(createdAcks(h)[0].text, /返回结果/);
  h.histories.set('NEW', [[initialTurn('actual-turn', 'WECHAT_MESSAGE_ID=1', 'completed', '不应发送的首轮正文')]]);
  await h.bridge.observe();
  await h.bridge.observe();
  assert.equal(results(h).length, 1);
  assert.equal(results(h)[0].requested, true);
  assert.match(results(h)[0].text, /本轮已结束/);
  assert.doesNotMatch(results(h)[0].text, /不应发送的首轮正文/);
  await h.bridge.sendPending();
  assert.equal(h.notices.length, 2);
  assert.equal(h.notices.some(n => n.text.includes('不应发送的首轮正文')), false);
});

testCreationModes('new chat stays subscribed for a later desktop turn without repeating the first requested result', async (t, mode) => {
  const h = await fixture(t);
  await h.receive(raw(1, mode.command));
  const first = initialTurn('first-turn', 'WECHAT_MESSAGE_ID=1', 'completed', '首轮结果');
  h.histories.set('NEW', [[first]]);
  await h.bridge.observe();
  await h.bridge.sendPending();
  const later = { id: 'desktop-turn', status: 'inProgress', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '电脑端继续' }] },
  ] };
  h.histories.set('NEW', [[later, first]]);
  await h.bridge.observe();
  assert.equal(results(h).length, 1, 'unfinished desktop turn has no result');
  later.status = 'completed';
  later.items.push({ type: 'agentMessage', phase: 'final_answer', text: '电脑端最终结果' });
  h.histories.set('NEW', [[later, first]]);
  await h.bridge.observe();
  await h.bridge.observe();
  await h.bridge.sendPending();
  await h.bridge.sendPending();
  assert.deepEqual(results(h).map(n => ({ turnId: n.turnId, requested: n.requested, status: n.status })), [
    { turnId: 'first-turn', requested: true, status: 'accepted' },
    { turnId: 'desktop-turn', requested: false, status: 'accepted' },
  ]);
  assert.equal(h.notices.length, 3, 'one creation acknowledgement and one result per completed turn');
  assert.equal(h.notices.filter(n => n.text.includes('电脑端最终结果')).length, 1);
});

test('initial userMessage first-line marker remains compatible with creation observation', async t => {
  const h = await fixture(t);
  await h.receive(raw(1, '新建 示例项目｜首条要求'));
  h.histories.set('NEW', [[{ id: 'user-message-turn', status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'WECHAT_MESSAGE_ID=1\n\n首条要求' }] },
    { type: 'agentMessage', phase: 'final_answer', text: '兼容格式结果' },
  ] }]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'completed');
  assert.equal(h.state.read().inbound[0].turnId, 'user-message-turn');
  assert.equal(results(h).length, 1);
  assert.match(results(h)[0].text, /兼容格式结果/);
  assert.equal(createdAcks(h).length, 1);
});

test('creation observation rejects wrong-tool, truncated and quoted delegation markers', async t => {
  for (const scenario of ['wrong-tool', 'truncated', 'quoted-marker']) {
    await t.test(scenario, async t => {
      const h = await fixture(t);
      await h.receive(raw(1, '新建 示例项目｜首条要求'));
      const item = creationItem('WECHAT_MESSAGE_ID=1');
      if (scenario === 'wrong-tool') item.name = 'send_message_to_thread';
      if (scenario === 'truncated') item.output.truncated = true;
      if (scenario === 'quoted-marker') item.output.text = item.output.text.replace('<input>WECHAT_MESSAGE_ID=1',
        '<input>请解释引用内容\nWECHAT_MESSAGE_ID=1');
      h.histories.set('NEW', [[{ id: 'unrelated-tool-turn', status: 'completed', items: [item,
        { type: 'agentMessage', phase: 'final_answer', text: '不应返回的结果' },
      ] }]]);
      await h.bridge.observe();
      assert.equal(h.state.read().inbound[0].status, 'submitted');
      assert.equal(h.state.read().inbound[0].turnId, undefined);
      assert.equal(results(h).length, 1);
      assert.equal(results(h)[0].requested, false, 'subscription result must not confirm the create request');
    });
  }
});

test('an unrelated completed turn or a marker quoted in a later userMessage cannot complete creation', async t => {
  const h = await fixture(t);
  await h.receive(raw(1, '新建 示例项目｜首条要求'));
  h.histories.set('NEW', [[{ id: 'unrelated', status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '请解释下面文字\nWECHAT_MESSAGE_ID=1\n\n首条要求' }] },
    { type: 'agentMessage', phase: 'final_answer', text: '无关结果' },
  ] }]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'submitted');
  assert.equal(results(h).length, 1);
  assert.equal(results(h)[0].requested, false);
});

test('legacy delivery output remains recoverable alongside the new userMessage marker', async t => {
  const h = await fixture(t);
  await h.receive(raw(1, '原有聊天要求'));
  await h.dispatch();
  h.histories.set('A', [[{ id: 'legacy', status: 'completed', items: [
    { type: 'functionCallOutput', name: 'send_message_to_thread', output: { text: '<input>WECHAT_MESSAGE_ID=1\n来源：本人微信，目标聊天 #1\n\n原有聊天要求</input>' } },
    { type: 'agentMessage', phase: 'final_answer', text: '旧格式最终结果' },
  ] }]]);
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'completed');
  assert.equal(results(h)[0].turnId, 'legacy');
});

testCreationModes('unknown create responses preserve selection, survive replay and never observe an undefined target', async (t, mode) => {
  for (const response of ['throw', {}, { threadId: '' }, { threadId: '   ' }, { threadId: 'NEW', hostId: 'remote-host' }]) {
    await t.test(JSON.stringify(response), async t => {
      const h = await fixture(t);
      const previousChat = h.state.read().chats.A;
      h.onCreate = async () => { if (response === 'throw') throw Error('lost after write'); return response; };
      const message = raw(1, mode.command);
      await h.receive(message);
      assert.equal(h.state.read().inbound[0].operation, 'create');
      assert.equal(h.state.read().inbound[0].status, 'unknown');
      assert.equal(h.state.read().inbound[0].target, undefined);
      assert.equal(h.state.read().chats.NEW, undefined);
      assert.deepEqual(h.state.read().chats.A, previousChat);
      assert.equal(h.state.read().selected, 'A');
      assert.match(h.state.read().notifications.map(n => n.text).join('\n'), /桌面|电脑/);
      await h.restart();
      await h.receive(message);
      await h.dispatch();
      await h.bridge.observe();
      assert.equal(h.creates.length, 1);
      assert.equal(h.sends.length, 0);
      assert.equal(h.reads.some(r => r.id === undefined), false);
      assert.equal(h.reads.some(r => r.id !== 'A'), false, 'invalid receipts must not invent an observation target');
      assert.equal(results(h).length, 0);
    });
  }
});

testCreationModes('restart converts an in-flight create without target to unknown and does not create or dispatch it again', async (t, mode) => {
  const h = await fixture(t);
  await h.bridge.acceptBatch({ msgs: [raw(1, mode.command)], get_updates_buf: 'crash-cursor' });
  await h.state.update(s => Object.assign(s.inbound[0], { operation: 'create', status: 'submitting',
    marker: 'WECHAT_MESSAGE_ID=1', projectId: mode.projectId, prompt: '首条要求' }));
  await h.restart();
  await h.receive(raw(1, mode.command));
  await h.dispatch();
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'unknown');
  assert.equal(h.state.read().selected, 'A');
  assert.equal(h.creates.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.reads.some(r => r.id === undefined), false);
});
