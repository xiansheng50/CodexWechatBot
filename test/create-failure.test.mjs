import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Bridge, INITIAL_STATE } from '../src/bridge.mjs';
import { JsonStore } from '../src/state-store.mjs';

const message = { message_id: '101', from_user_id: 'owner', to_user_id: 'bot',
  message_type: 1, message_state: 2,
  item_list: [{ type: 1, text_item: { text: '新建 Demo｜首条要求' } }] };
const batch = { msgs: [message], get_updates_buf: 'failure-test-cursor' };
const existingThread = { id: 'A', hostId: 'local', kind: 'codex', title: 'Existing' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wechatbot-create-failure-'));
  const path = join(directory, 'state.json');
  const h = { directory, path, creates: 0, reads: [], turns: [], beforeWrite: async () => {},
    onCreate: async () => ({ threadId: 'NEW', hostId: 'local' }) };
  t.after(async () => {
    h.bridge?.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('wechatbot-create-failure-'));
    await rm(directory, { recursive: true, force: true });
  });
  h.restart = async () => {
    h.bridge?.close();
    h.state = new JsonStore(path, INITIAL_STATE, { write: async (target, value) => {
      await h.beforeWrite(value);
      await writeFile(target, JSON.stringify(value), 'utf8');
    } });
    await h.state.load();
    const desktop = {
      async validate() { return { thread: existingThread }; },
      async projects() { return { projects: [{ projectId: 'demo', projectKind: 'local',
        hostId: 'local', label: 'Demo', path: 'D:\\Projects\\Demo' }] }; },
      async create() { h.creates++; return h.onCreate(); },
      async read(id) {
        h.reads.push(id);
        assert.equal(typeof id, 'string', 'observer must never read an unknown target');
        assert.ok(['A', 'NEW'].includes(id), `unexpected fake thread ${id}`);
        return { thread: id === 'A' ? existingThread : { ...existingThread, id: 'NEW', title: 'Created' },
          turns: id === 'NEW' ? structuredClone(h.turns) : [], page: { hasMore: false, nextCursor: null } };
      },
      async send() { assert.fail('Creation must never fall through to a send'); },
      close() {},
    };
    h.bridge = new Bridge({ state: h.state,
      credentials: { read: () => ({ botId: 'bot', userId: 'owner' }) },
      config: { read: () => ({ boundAt: 'already-bound' }) },
      weixin: { async sendText() { assert.fail('No external messages in this test'); } },
      desktopFactory: () => desktop });
    await h.bridge.init();
    await h.bridge.register({ callerThreadId: 'A', pipePath: 'test-only' });
    await h.state.update(s => {
      if (!s.selected) {
        s.selected = 'A';
        Object.assign(s.chats.A, { enabled: true, enabledAt: new Date().toISOString(),
          observation: { anchor: null, pending: [] } });
      }
    });
  };
  await h.restart();
  h.persisted = async () => JSON.parse(await readFile(path, 'utf8'));
  return h;
}

test('a failed receipt save retains the known created chat for read-only recovery and one final result', async t => {
  const h = await fixture(t);
  const previousChat = h.state.read().chats.A;
  let failed = false;
  h.beforeWrite = async value => {
    if (!failed && value.inbound[0]?.status === 'submitted') {
      failed = true;
      throw new Error('Injected creation receipt save failure');
    }
  };
  await h.bridge.acceptBatch(batch);
  await h.bridge.processInbound();
  const saved = await h.persisted();
  assert.equal(failed, true);
  assert.equal(saved.inbound[0].status, 'unknown');
  assert.equal(saved.inbound[0].target, 'NEW');
  assert.equal(saved.chats.NEW.threadId, 'NEW');
  assert.equal(saved.chats.NEW.number, 2);
  assert.equal(saved.chats.NEW.enabled, false);
  assert.equal(saved.selected, 'A');
  assert.deepEqual(saved.chats.A, previousChat);

  await h.restart();
  await h.bridge.acceptBatch(batch);
  await h.bridge.processInbound();
  await Promise.all(h.bridge.dispatchReady());
  assert.equal(h.creates, 1);
  assert.equal(h.state.read().chats.NEW.number, saved.chats.NEW.number);
  h.turns = [{ id: 'created-turn', status: 'inProgress', items: [
    { type: 'functionCallOutput', name: 'create_thread', namespace: 'codex_app',
      output: { text: '<codex_delegation>\n<source_thread_id>A</source_thread_id>\n<input>WECHAT_MESSAGE_ID=101\n\n首条要求</input>\n</codex_delegation>', truncated: false } },
    { type: 'agentMessage', phase: 'final_answer', text: '创建后的最终结果' },
  ] }];
  await h.bridge.observe();
  assert.equal(h.state.read().inbound[0].status, 'confirmed');
  assert.equal(h.state.read().inbound[0].turnId, 'created-turn');
  assert.equal(h.state.read().notifications.filter(n => n.kind === 'result').length, 0);
  h.turns[0].status = 'completed';
  await h.bridge.observe();
  await h.bridge.observe();
  const completed = h.state.read();
  assert.equal(completed.inbound[0].status, 'completed');
  assert.equal(completed.chats.NEW.number, saved.chats.NEW.number);
  assert.equal(completed.chats.NEW.enabled, false);
  assert.equal(completed.selected, 'A');
  assert.deepEqual(completed.chats.A, previousChat);
  assert.deepEqual(h.reads.filter(id => id === 'NEW'), ['NEW', 'NEW']);
  assert.ok(h.reads.every(id => ['A', 'NEW'].includes(id)));
  assert.equal(h.creates, 1);
  const results = completed.notifications.filter(n => n.kind === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].requested, true);
  assert.equal(results[0].turnId, 'created-turn');
  assert.match(results[0].text, /创建后的最终结果/);
});

test('a failed creation receipt save and failed unknown notice do not report not-executed or create again', async t => {
  const h = await fixture(t);
  const previousChat = h.state.read().chats.A;
  const previousNotices = [
    { id: 'previous-subscription', kind: 'result', threadId: 'A', requested: false, status: 'pending', text: '原订阅结果' },
    { id: 'previous-requested', kind: 'result', threadId: 'A', requested: true, status: 'pending', text: '原请求结果' },
  ];
  await h.state.update(s => s.notifications.push(...previousNotices));
  let receiptFailed = false, unknownNoticeFailed = false;
  h.beforeWrite = async value => {
    if (!receiptFailed && value.inbound[0]?.status === 'submitted') {
      receiptFailed = true;
      throw new Error('Injected creation receipt save failure');
    }
    if (!unknownNoticeFailed && value.notifications.some(n => n.id.startsWith('unknown:'))) {
      unknownNoticeFailed = true;
      throw new Error('Injected first unknown notice save failure');
    }
  };
  await h.bridge.acceptBatch(batch);
  await h.bridge.processInbound();
  assert.equal(receiptFailed && unknownNoticeFailed, true, 'exercise both catch boundaries');
  assert.equal((await h.persisted()).inbound[0].status, 'unknown');
  assert.equal(h.state.read().notifications.some(n => /未执行/.test(n.text)), false);
  assert.equal(h.state.read().selected, 'A');
  assert.deepEqual(h.state.read().chats.A, previousChat);
  assert.equal(h.state.read().chats.NEW.enabled, false);
  assert.deepEqual(h.state.read().notifications.filter(n => n.threadId === 'A'), previousNotices);
  await h.restart();
  await h.bridge.acceptBatch(batch);
  await h.bridge.processInbound();
  await Promise.all(h.bridge.dispatchReady());
  assert.equal(h.creates, 1);
  assert.equal(h.state.read().inbound[0].status, 'unknown');
});

test('persistent local write failure after external creation recovers as unknown without retrying creation', async t => {
  const h = await fixture(t);
  const previousChat = h.state.read().chats.A;
  h.onCreate = async () => {
    h.beforeWrite = async () => { throw new Error('Injected disk failure after dispatch'); };
    return { threadId: 'NEW', hostId: 'local' };
  };
  await h.bridge.acceptBatch(batch);
  await assert.rejects(h.bridge.processInbound(), /Injected disk failure/);
  assert.equal((await h.persisted()).inbound[0].status, 'submitting');
  h.beforeWrite = async () => {};
  await h.restart();
  await h.bridge.acceptBatch(batch);
  await h.bridge.processInbound();
  await Promise.all(h.bridge.dispatchReady());
  assert.equal(h.creates, 1);
  assert.equal(h.state.read().inbound[0].status, 'unknown');
  assert.equal(h.state.read().selected, 'A');
  assert.deepEqual(h.state.read().chats.A, previousChat);
  assert.equal(h.state.read().chats.NEW, undefined);
  assert.equal(h.state.read().notifications.some(n => /未执行/.test(n.text)), false);
});

test('stopping while the pre-dispatch intent saves leaves the unsent create resumable exactly once', async t => {
  const h = await fixture(t);
  let stopped = false;
  h.beforeWrite = async value => {
    if (!stopped && value.inbound[0]?.status === 'submitting') {
      stopped = true;
      h.bridge.close();
    }
  };
  await h.bridge.acceptBatch(batch);
  await h.bridge.processInbound();
  assert.equal(h.creates, 0);
  assert.equal((await h.persisted()).inbound[0].status, 'received');
  await h.restart();
  await h.bridge.acceptBatch(batch);
  await h.bridge.processInbound();
  await h.bridge.processInbound();
  assert.equal(h.creates, 1);
  assert.equal(h.state.read().inbound[0].status, 'submitted');
  assert.equal(h.state.read().selected, 'NEW');
  assert.equal(h.state.read().chats.NEW.enabled, true);
  assert.equal(h.state.read().chats.A.enabled, false);
});

test('stopping after dispatch records an uncertain create without starting the next create', async t => {
  const h = await fixture(t);
  h.onCreate = async () => {
    h.bridge.close();
    throw new Error('Desktop transport closed after dispatch');
  };
  await h.bridge.acceptBatch({ msgs: [message, { ...message, message_id: '102' }],
    get_updates_buf: 'two-create-cursor' });
  await h.bridge.processInbound();
  assert.deepEqual((await h.persisted()).inbound.map(row => row.status), ['unknown', 'received']);
  assert.equal(h.creates, 1);
});
