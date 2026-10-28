import { randomUUID } from 'node:crypto';
import { DesktopClient } from './desktop-client.mjs';
import { HELP, parseCommand, ensureChat, byNumber, listText } from './routing.mjs';
import { isTerminal, deliveryInTurn, finalText, addNotice, recoverState, truncate } from './notifications.mjs';
import { normalizeInbound } from './weixin-client.mjs';
import { resolveProject, projectListText } from './projects.mjs';

export const INITIAL_STATE = { version: 1, nextNumber: 1, chats: {}, selected: null,
  desktopCandidate: null, cursor: '', inbound: [], notifications: [] };

function updateNotifications(state, chat, enabled, turns = []) {
  if (chat.enabled === enabled) return;
  chat.enabled = enabled;
  if (enabled) {
    chat.enabledAt = new Date().toISOString();
    chat.observation = { anchor: turns[0]?.id || null,
      pending: turns.filter(t => !isTerminal(t)).map(t => t.id) };
    delete chat.observationGap;
  } else {
    for (const n of state.notifications) if (n.threadId === chat.threadId && n.kind === 'result' && n.status === 'pending' && !n.requested) n.status = 'cancelled';
  }
}

function selectChat(state, chat, turns = []) {
  const previous = state.chats[state.selected];
  if (previous && previous.threadId !== chat.threadId) updateNotifications(state, previous, false);
  updateNotifications(state, chat, true, turns);
  state.selected = chat.threadId;
}

export class Bridge {
  constructor({ state, credentials, config, weixin, desktopFactory = c => new DesktopClient(c), log = () => {} }) {
    Object.assign(this, { state, credentials, config, weixin, desktopFactory, log });
    this.threadQueues = new Map();
    this.closed = false;
    this.errors = {};
  }
  async init() {
    await this.state.update(s => recoverState(s));
    if (Object.hasOwn(this.credentials.read(), 'contextVersion')) await this.credentials.update(c => { delete c.contextVersion; });
    const candidate = this.state.read().desktopCandidate;
    if (candidate) { try { await this.register(candidate); } catch { this.errors.desktop = '保存的桌面连接已失效，等待 MCP 重新注册'; } }
  }
  async register(connection) {
    if (this.closed) throw new Error('Bridge is stopping');
    connection = { ...connection, hostId: connection.hostId || 'local' };
    if (typeof connection.pipePath !== 'string' || !connection.pipePath ||
        typeof connection.callerThreadId !== 'string' || !connection.callerThreadId.trim() || connection.hostId !== 'local') throw new Error('A local pipe and trusted caller thread are required');
    if (this.desktop && this.connection?.pipePath === connection.pipePath) {
      // The transport is calibrated once; the action validates the current caller by reading it.
      this.desktop.setCaller?.(connection.callerThreadId, connection.callerTurnId);
      this.connection = connection;
      return this.state.read().chats[connection.callerThreadId] || null;
    }
    const next = this.desktopFactory(connection);
    try {
      const checked = await next.validate();
      if (this.closed) throw new Error('Bridge is stopping');
      await this.state.update(s => { ensureChat(s, checked.thread); s.desktopCandidate = connection; });
      if (this.closed) throw new Error('Bridge is stopping');
      if (this.desktop && this.connection?.pipePath === connection.pipePath) {
        next.close();
        this.desktop.setCaller?.(connection.callerThreadId, connection.callerTurnId);
      } else {
        const old = this.desktop;
        this.desktop = next;
        old?.close();
      }
      this.connection = connection;
      delete this.errors.desktop;
      return this.state.read().chats[checked.thread.id];
    } catch (e) { next.close(); throw e; }
  }
  requireDesktop() {
    if (!this.desktop) throw new Error('桌面未连接，请打开 Codex 并调用 wechat_status');
    return this.desktop;
  }
  async readChat(threadId, options, connection) {
    try {
      const data = await this.requireDesktop().read(threadId, options, connection);
      delete this.errors.desktop;
      return data;
    }
    catch (e) { this.errors.desktop = '桌面读取失败，请在电脑运行 doctor 或调用 wechat_status'; throw e; }
  }
  async chatCurrent(threadId, connection = this.connection) {
    const data = await this.readChat(threadId, { turnLimit: 1, includeOutputs: false }, connection);
    await this.state.update(s => this.rememberChat(s, data.thread, connection));
    return data;
  }
  rememberChat(state, thread, connection) {
    const chat = ensureChat(state, thread);
    if (connection?.callerThreadId === thread.id) state.desktopCandidate = connection;
    return chat;
  }
  async select(threadId, connection = this.connection) {
    const data = await this.readChat(threadId, { turnLimit: 1, includeOutputs: false }, connection);
    await this.state.update(s => { selectChat(s, this.rememberChat(s, data.thread, connection), data.turns); });
    return this.state.read().chats[threadId];
  }
  async setNotifications(threadId, enabled, connection = this.connection) {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是 boolean');
    const data = await this.readChat(threadId, { turnLimit: 1, includeOutputs: false }, connection);
    await this.state.update(s => {
      const chat = this.rememberChat(s, data.thread, connection);
      updateNotifications(s, chat, enabled, data.turns);
    });
    return this.state.read().chats[threadId];
  }
  status() {
    const state = this.state.read();
    const creds = this.credentials.read();
    return { desktop: this.desktop && !this.errors.desktop ? 'connected' : 'disconnected',
      weixin: !creds.botToken ? 'not_configured' : this.errors.auth ? 'login_required' : this.config.read().boundAt ? 'connected' : 'awaiting_owner_message',
      selected: state.selected ? state.chats[state.selected] : null,
      subscriptions: Object.values(state.chats).filter(c => c.enabled).map(c => ({ number: c.number, title: c.title })),
      undelivered: state.notifications.filter(n => !['accepted', 'cancelled'].includes(n.status)).map(n => ({ id: n.id, status: n.status, error: n.error, transport: n.transport })),
      unknownSubmissions: state.inbound.filter(m => m.status === 'unknown').map(m => ({ id: m.id, number: state.chats[m.target]?.number,
        ...(m.operation === 'create' ? { operation: 'create', project: m.projectLabel } : {}) })),
      observationGaps: Object.values(state.chats).filter(c => c.observationGap).map(c => ({ number: c.number, error: c.observationGap })),
      errors: this.errors };
  }
  statusText() {
    const s = this.status();
    return `桌面：${s.desktop}\n微信：${s.weixin}\n当前目标：${s.selected ? `#${s.selected.number} ${s.selected.title}` : '未选择'}\n通知订阅：${s.subscriptions.length}\n未送达/未知：${s.undelivered.length}\n提交待确认：${s.unknownSubmissions.length}\n${Object.values(s.errors).join('\n')}`.trim();
  }
  async discover() {
    const result = await this.requireDesktop().list({ limit: 50 });
    await this.state.update(s => {
      for (const thread of [...(result.pinnedThreads || []), ...(result.threads || [])]) {
        if (thread.hostId === 'local' && thread.kind === 'codex' && !thread.isSubagent && !thread.parentThreadId && !thread.archived) ensureChat(s, thread);
      }
    });
  }
  async acceptBatch(batch) {
    if (!Array.isArray(batch.msgs) || typeof batch.get_updates_buf !== 'string') throw new Error('无效微信收取批次，未推进游标');
    const creds = this.credentials.read();
    const messages = batch.msgs.map(m => normalizeInbound(m, creds)).filter(Boolean);
    if (messages.length !== batch.msgs.length) await this.log('inbound_ignored', { count: batch.msgs.length - messages.length });
    const existing = new Set(this.state.read().inbound.map(m => m.id));
    const latest = messages.findLast(m => !existing.has(m.id) && m.contextToken);
    if (latest) await this.credentials.update(c => { c.contextToken = latest.contextToken; });
    // Context is saved before cursor; only persisted messages can be dispatched.
    await this.state.update(s => {
      for (const message of messages) if (!s.inbound.some(m => m.id === message.id)) {
        const { contextToken, ...record } = message;
        s.inbound.push({ ...record, status: 'received', receivedAt: new Date().toISOString() });
      }
      s.cursor = batch.get_updates_buf;
    });
    if (messages.length && this.credentials.read().contextToken && !this.config.read().boundAt) {
      await this.config.update(c => { c.boundAt = new Date().toISOString(); });
      await this.state.update(s => addNotice(s, { id: 'binding', kind: 'reply', text: `微信已连接。\n${HELP}` }));
    }
    delete this.errors.receive;
  }
  async reply(id, text) {
    await this.state.update(s => addNotice(s, { id, kind: 'reply', text: truncate(text) }));
  }
  async processInbound() {
    if (this.processing) return;
    this.processing = true;
    try {
      for (const record of this.state.read().inbound.filter(m => m.status === 'received')) {
        try {
          if (!record.isText) { await this.reply(`reply:${record.id}`, '第一版仅支持文字，请在微信输入文字。'); }
          else {
            const cmd = parseCommand(record.text);
            if (cmd.type === 'help') await this.reply(`reply:${record.id}`, HELP);
            else if (cmd.type === 'status') await this.reply(`reply:${record.id}`, this.statusText());
            else if (cmd.type === 'list') { await this.discover(); await this.reply(`reply:${record.id}`, listText(this.state.read(), cmd.page)); }
            else if (cmd.type === 'projects') {
              const projects = await this.requireDesktop().projects();
              await this.reply(`reply:${record.id}`, projectListText(projects, cmd.page));
            } else if (cmd.type === 'invalid_create') throw new Error('用法：新建｜首条要求，或新建 项目名｜首条要求。先发送“项目”查看可用项目。');
            else if (cmd.type === 'create') { await this.createChat(record, cmd); continue; }
            else if (cmd.type === 'select') {
              const chat = byNumber(this.state.read(), cmd.number);
              await this.select(chat.threadId);
              await this.reply(`reply:${record.id}`, `已选择 #${chat.number} ${chat.title}，普通文字将发给此聊天，持续完成通知已开启。`);
            } else if (cmd.type === 'notifications') {
              const chat = byNumber(this.state.read(), cmd.number);
              await this.setNotifications(chat.threadId, cmd.enabled);
              await this.reply(`reply:${record.id}`, `#${chat.number} 通知已${cmd.enabled ? '开启' : '关闭'}。`);
            } else {
              const s = this.state.read();
              const chat = cmd.number ? byNumber(s, cmd.number) : s.chats[s.selected];
              if (!chat) throw new Error('尚未选择聊天，请先发送“列表”，再发送“切换 #编号”');
              if (!cmd.text) throw new Error('请在编号后填写要求，例如 #3 请继续检查');
              await this.state.update(s => {
                const m = s.inbound.find(m => m.id === record.id);
                m.target = chat.threadId; m.prompt = cmd.text; m.status = 'ready';
              });
              continue;
            }
          }
          await this.state.update(s => { s.inbound.find(m => m.id === record.id).status = 'handled'; });
        } catch (e) {
          const saved = this.state.read().inbound.find(m => m.id === record.id);
          if (saved?.operation === 'create' && ['submitting', 'submitted', 'unknown'].includes(saved.status)) {
            // A failed local save after dispatch cannot turn an uncertain create into "not executed".
            this.errors.submit = '新建聊天的结果待确认，请在桌面核对；不会自动重建。';
            await this.state.update(s => { s.inbound.find(m => m.id === record.id).status = 'unknown'; });
            await this.reply(`unknown:${record.id}`, `新建聊天状态待确认（项目：${saved.projectLabel}）。请在桌面核对，服务不会自动重建或重发首条要求。`);
            continue;
          }
          await this.reply(`reply:${record.id}`, `未执行：${e.message}`);
          await this.state.update(s => { const m = s.inbound.find(m => m.id === record.id); m.status = 'rejected'; m.error = e.message; });
        }
      }
    } finally { this.processing = false; }
  }
  async createChat(record, cmd) {
    const desktop = this.requireDesktop();
    const project = cmd.project === null ? null : resolveProject(await desktop.projects(), cmd.project);
    const projectId = project?.projectId ?? null;
    const projectLabel = project?.label ?? '无项目';
    // Preflight unsupported creation before persisting an intent that might have been dispatched.
    if (typeof desktop.create !== 'function' || desktop.canCreate?.(projectId) === false) throw new Error('当前桌面不支持此类型的新建聊天，请运行 doctor 检查');
    if (this.closed) return;
    const marker = `WECHAT_MESSAGE_ID=${record.id}`;
    await this.state.update(s => {
      const row = s.inbound.find(m => m.id === record.id);
      Object.assign(row, { operation: 'create', projectId, projectLabel,
        prompt: cmd.text, marker, status: 'submitting', attemptedAt: new Date().toISOString() });
    });
    if (this.closed) {
      await this.state.update(s => { s.inbound.find(m => m.id === record.id).status = 'received'; });
      return;
    }
    let createdThreadId;
    try {
      const result = await desktop.create(projectId, `${marker}\n\n${cmd.text}`);
      if (typeof result?.threadId !== 'string' || !result.threadId.trim() || (result.hostId && result.hostId !== 'local')) {
        throw new Error('创建回执没有可确认的本地聊天 ID');
      }
      createdThreadId = result.threadId;
      await this.state.update(s => {
        const row = s.inbound.find(m => m.id === record.id);
        row.target = result.threadId; row.status = 'submitted';
        const chat = ensureChat(s, { id: result.threadId, hostId: 'local', kind: 'codex', title: `新聊天（${projectLabel}）` });
        selectChat(s, chat);
        addNotice(s, { id: `ack:${record.id}`, kind: 'reply', text: `已创建 #${chat.number}（项目：${projectLabel}），已切换为当前目标并开启持续完成通知。首条要求已受理，本轮结束后返回结果。` });
      });
    } catch {
      await this.state.update(s => {
        const row = s.inbound.find(m => m.id === record.id);
        row.status = 'unknown';
        if (createdThreadId) {
          row.target = createdThreadId;
          ensureChat(s, { id: createdThreadId, hostId: 'local', kind: 'codex', title: `新聊天（${projectLabel}）` });
        }
      });
      await this.reply(`unknown:${record.id}`, `新建聊天状态待确认（项目：${projectLabel}）。请在桌面核对，服务不会自动重建或重发首条要求。`);
    }
  }
  dispatchReady() {
    if (!this.desktop || this.closed) return [];
    const targets = [...new Set(this.state.read().inbound.filter(m => m.status === 'ready').map(m => m.target))];
    return targets.map(target => {
      if (this.threadQueues.has(target)) return this.threadQueues.get(target);
      const task = this.dispatchThread(target).catch(e => { this.errors.submit = e.message; }).finally(() => this.threadQueues.delete(target));
      this.threadQueues.set(target, task);
      return task;
    });
  }
  async dispatchThread(target) {
    for (const m of this.state.read().inbound.filter(m => m.status === 'ready' && m.target === target)) {
      if (this.closed || !this.desktop) return;
      try { await this.chatCurrent(target); }
      catch (e) {
        if (e.code === 'TARGET_UNAVAILABLE') {
          await this.state.update(s => { const row = s.inbound.find(i => i.id === m.id); row.status = 'rejected'; row.error = e.message; });
          await this.reply(`reply:${m.id}`, `未执行：#${this.state.read().chats[target].number} ${e.message}`);
          continue;
        }
        // A failed read is not proof of deletion. Preserve unsent intent for reconnect.
        return;
      }
      if (this.closed) return;
      const marker = `WECHAT_MESSAGE_ID=${m.id}`;
      await this.state.update(s => { const row = s.inbound.find(i => i.id === m.id); row.status = 'submitting'; row.marker = marker; row.attemptedAt = new Date().toISOString(); });
      if (this.closed) { await this.state.update(s => { s.inbound.find(i => i.id === m.id).status = 'ready'; }); return; }
      try {
        await this.desktop.send(target, `${marker}\n\n${m.prompt}`);
        await this.state.update(s => { s.inbound.find(i => i.id === m.id).status = 'submitted'; });
      } catch {
        await this.state.update(s => { s.inbound.find(i => i.id === m.id).status = 'unknown'; });
        await this.reply(`unknown:${m.id}`, `#${this.state.read().chats[target].number} 提交状态待确认，请检查原聊天；服务不会自动重发。`);
      }
    }
  }
  async observeChat(threadId) {
    const snapshot = this.state.read();
    const chat = snapshot.chats[threadId];
    if (!chat) return;
    const wanted = snapshot.inbound.filter(m => m.target === threadId && ['submitted', 'unknown', 'confirmed'].includes(m.status));
    const includeOutputs = wanted.some(m => !m.turnId);
    const obs = chat.enabled ? chat.observation : { anchor: null, pending: [] };
    const turns = [];
    let cursor, latestThread;
    let anchorFound = !obs.anchor;
    const seenCursors = new Set();
    do {
      const data = await this.readChat(threadId, { includeOutputs, ...(cursor ? { cursor } : {}) });
      latestThread ||= data.thread;
      turns.push(...data.turns);
      anchorFound ||= data.turns.some(t => t.id === obs.anchor);
      const pendingFound = obs.pending.every(id => turns.some(t => t.id === id));
      const markersFound = wanted.every(m => turns.some(t => m.turnId ? t.id === m.turnId : deliveryInTurn(t, m.marker, m.operation)));
      if ((anchorFound && pendingFound && markersFound) || !data.page.hasMore) break;
      cursor = data.page.nextCursor;
      if (!cursor || seenCursors.has(cursor)) throw new Error('Desktop pagination did not advance');
      seenCursors.add(cursor);
    } while (!this.closed);
    await this.state.update(s => {
      if (latestThread) ensureChat(s, latestThread);
      const current = s.chats[threadId];
      // A subscription toggled during read must not adopt an obsolete baseline.
      const subscriptionUnchanged = current.enabled && current.enabledAt === chat.enabledAt;
      const anchorIndex = obs.anchor ? turns.findIndex(t => t.id === obs.anchor) : turns.length;
      const newer = anchorIndex >= 0 ? turns.slice(0, anchorIndex) : [];
      const subscriptionTurns = subscriptionUnchanged ? [...newer, ...turns.filter(t => obs.pending.includes(t.id))] : [];
      if (subscriptionUnchanged && !anchorFound) {
        current.observationGap = '无法找到上次观察位置；未重放无法确认范围的历史，请在桌面核对。';
        addNotice(s, { id: `gap:${threadId}:${obs.anchor}`, kind: 'reply', text: `#${current.number} ${current.observationGap}` });
      }
      for (const m of s.inbound.filter(m => m.target === threadId && ['submitted', 'unknown'].includes(m.status))) {
        const turn = turns.find(t => deliveryInTurn(t, m.marker, m.operation));
        if (!turn) {
          if (m.status === 'submitted' && Date.now() - Date.parse(m.attemptedAt) > 30_000) {
            m.status = 'unknown';
            addNotice(s, { id: `unknown:${m.id}`, kind: 'reply', text: `#${current.number} 提交已受理但尚未定位实际轮次，请检查原聊天；服务不会自动重发。` });
          }
          continue;
        }
        m.turnId = turn.id; m.status = 'confirmed';
        addNotice(s, { id: `ack:${m.id}`, kind: 'reply', text: `已确认转入 #${current.number} ${current.title}。本轮结束后返回结果。` });
      }
      const requestedTurns = s.inbound.filter(m => m.target === threadId && m.status === 'confirmed').map(m => m.turnId);
      for (const turn of turns.filter(t => isTerminal(t))) {
        const requested = requestedTurns.includes(turn.id);
        if (!requested && !subscriptionTurns.some(t => t.id === turn.id)) continue;
        const selectedNumber = s.chats[s.selected]?.number;
        addNotice(s, { id: `result:${threadId}:${turn.id}`, kind: 'result', threadId, turnId: turn.id,
          requested, text: finalText(current, turn, selectedNumber) });
        for (const m of s.inbound.filter(m => m.target === threadId && m.turnId === turn.id)) m.status = 'completed';
      }
      if (subscriptionUnchanged) {
        current.observation = { anchor: turns[0]?.id || obs.anchor,
          pending: [...new Set([...obs.pending, ...subscriptionTurns.filter(t => !isTerminal(t)).map(t => t.id)])].filter(id => !turns.some(t => t.id === id && isTerminal(t))) };
      }
    });
  }
  async observe() {
    if (!this.desktop || this.observing || this.closed) return;
    this.observing = true;
    try {
      const s = this.state.read();
      const ids = [...new Set([...Object.values(s.chats).filter(c => c.enabled).map(c => c.threadId),
        ...s.inbound.filter(m => m.target && ['submitted', 'unknown', 'confirmed'].includes(m.status)).map(m => m.target)])];
      let index = 0, failed = false;
      await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
        while (index < ids.length && !this.closed) {
          const id = ids[index++];
          try { await this.observeChat(id); } catch { failed = true; this.errors.observe = '观察失败，已保留观察位置；请在电脑检查连接。'; }
        }
      }));
      if (!failed) delete this.errors.observe;
    } finally { this.observing = false; }
  }
  async sendPending() {
    if (this.sending || this.closed) return;
    this.sending = true;
    try {
      for (const notice of this.state.read().notifications.filter(n => n.status === 'pending')) {
        if (this.closed) return;
        const c = this.credentials.read();
        if (!c.botToken || !c.contextToken || this.errors.auth) return;
        let dispatched = false;
        await this.state.update(s => {
          const current = s.notifications.find(n => n.id === notice.id);
          if (current.status !== 'pending') return;
          current.status = 'sending'; current.clientId ||= `wechatbot-${randomUUID()}`;
          current.attemptedAt = new Date().toISOString(); dispatched = true;
        });
        if (!dispatched) continue;
        if (this.closed) { await this.state.update(s => { s.notifications.find(n => n.id === notice.id).status = 'pending'; }); return; }
        const current = this.state.read().notifications.find(n => n.id === notice.id);
        try {
          await this.weixin.sendText(c, { toUserId: c.userId, text: current.text, clientId: current.clientId, contextToken: c.contextToken });
          await this.state.update(s => { const n = s.notifications.find(n => n.id === notice.id); n.status = 'accepted'; n.acceptedAt = new Date().toISOString(); delete n.error; });
          delete this.errors.send;
        } catch (e) {
          await this.state.update(s => {
            const n = s.notifications.find(n => n.id === notice.id);
            n.status = ['auth', 'rejected', 'context'].includes(e.category) ? 'rejected' : 'unknown';
            n.error = `微信发送${n.status === 'unknown' ? '状态未知' : '被拒绝'}${e.code !== undefined ? `，返回码 ${e.code}` : ''}`;
            if (e.transport) n.transport = e.transport;
          });
          this.errors.send = `最近一次微信发送失败 (${e.code || 'UNKNOWN'})，请查看未送达记录。`;
          await this.log('send_error', { noticeId: notice.id, code: e.code || 'UNKNOWN', category: e.category || 'unknown', transport: e.transport });
          if (e.category === 'auth') { this.errors.auth = '微信登录凭据失效，请重新扫码'; return; }
        }
      }
    } finally { this.sending = false; }
  }
  async retryNotice(id) {
    await this.state.update(s => {
      const n = s.notifications.find(n => n.id === id);
      if (!n) throw new Error('未知通知');
      if (['pending', 'sending', 'accepted', 'cancelled'].includes(n.status)) throw new Error(`该通知当前为 ${n.status}，不允许手动重发`);
      n.status = 'pending'; n.manualRetries = (n.manualRetries || 0) + 1;
    });
  }
  async maintain() {
    // Retain deduplication IDs even after trimming payloads; cursor alone cannot prove an old batch won't repeat.
    await this.state.update(s => {
      const terminal = s.inbound.filter(m => ['handled', 'rejected', 'completed'].includes(m.status));
      for (const m of terminal.slice(0, -1000)) { delete m.text; delete m.prompt; delete m.contextToken; }
      const sent = s.notifications.filter(n => ['accepted', 'cancelled'].includes(n.status));
      for (const n of sent.slice(0, -1000)) { delete n.text; }
    });
  }
  close() { this.closed = true; this.desktop?.close(); }
}
