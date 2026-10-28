import net from 'node:net';
import { randomUUID } from 'node:crypto';

const MAX_FRAME = 8 * 1024 * 1024;
const REQUIRED = ['list_threads', 'read_thread', 'send_message_to_thread'];
const ALLOWED = [...REQUIRED, 'list_projects', 'create_thread'];
const createArguments = (projectId, prompt) => ({ target: projectId === null ? { type: 'projectless' } :
  { type: 'project', projectId, environment: { type: 'local' } }, prompt });

// These errors require a readable Desktop reply, rather than a failed transport.
export function isDesktopToolRejection(error) {
  return ['TARGET_UNAVAILABLE', 'DESKTOP_RESPONSE_TOO_LARGE', 'DESKTOP_TOOL_REJECTED'].includes(error?.code);
}

// Check the exact optional capability we use, including required nested fields.
function accepts(schema, value) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.oneOf || schema.allOf || schema.not) return false;
  if (schema.anyOf) return Array.isArray(schema.anyOf) && schema.anyOf.some(s => accepts(s, value));
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.includes(value))) return false;
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength || 0);
  if (schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const properties = schema.properties || {};
  if (typeof properties !== 'object' || Array.isArray(properties) ||
      schema.required !== undefined && !Array.isArray(schema.required)) return false;
  return (schema.required || []).every(k => Object.hasOwn(value, k)) &&
    Object.entries(value).every(([k, v]) => properties[k] && accepts(properties[k], v));
}

// Internal Desktop protocol; all adaptation stays here. No alternate executor.
export class NativePipeClient {
  constructor(pipePath, { timeoutMs = 20000 } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
  }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => socket.destroy(new Error('Desktop pipe connection timed out')), this.timeoutMs);
      const fail = e => { clearTimeout(timer); reject(e); };
      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
          try { this.receive(chunk); } catch (e) { socket.destroy(e); }
        });
        socket.on('error', e => this.disconnect(socket, e));
        socket.on('close', () => this.disconnect(socket, new Error('Desktop pipe closed')));
        resolve();
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  disconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME) throw new Error('Invalid Desktop frame length');
      if (this.buffer.length < 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(4 + length);
      if (message.jsonrpc !== '2.0') throw new Error('Invalid Desktop JSON-RPC response');
      const p = this.pending.get(message.id);
      if (!p) continue;
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    }
  }
  async request(method, params) {
    await this.connect();
    const id = ++this.nextId;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (payload.length > MAX_FRAME) throw new Error('Desktop request too large');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Desktop ${method} timed out; write outcome may be unknown`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, payload]));
    });
  }
  close() { this.socket?.destroy(); }
}

export class DesktopClient {
  constructor({ pipePath, hostId = 'local', callerThreadId, callerTurnId }, options) {
    if (!pipePath || !callerThreadId || hostId !== 'local') throw new Error('A local pipe and trusted caller thread are required');
    this.connection = { pipePath, hostId, callerThreadId, callerTurnId };
    this.pipe = new NativePipeClient(pipePath, options);
  }
  setCaller(callerThreadId, callerTurnId) {
    if (typeof callerThreadId !== 'string' || !callerThreadId.trim()) throw new Error('Missing trusted caller thread');
    this.connection = { ...this.connection, callerThreadId, callerTurnId };
  }
  async validate() {
    const result = await this.pipe.request('tools/list', { threadStartKind: 'all' });
    if (!Array.isArray(result?.tools)) throw new Error('Unsupported Desktop catalog');
    this.tools = new Map();
    for (const name of REQUIRED) {
      const tool = result.tools.find(t => t.name === name);
      if (!tool?.namespace || !tool.inputSchema?.properties?.threadId && name !== 'list_threads') {
        throw new Error(`Desktop schema missing: ${name}`);
      }
      const supported = {
        list_threads: ['limit'],
        read_thread: ['threadId', 'hostId', 'cursor', 'turnLimit', 'includeOutputs', 'maxOutputCharsPerItem'],
        send_message_to_thread: ['threadId', 'hostId', 'prompt'],
      }[name];
      const properties = tool.inputSchema.properties;
      if (supported.some(key => !properties?.[key]) || (tool.inputSchema.required || []).some(key => !supported.includes(key))) {
        throw new Error(`Unsupported Desktop tool schema: ${name}`);
      }
      if (name === 'send_message_to_thread' && properties.prompt.type !== 'string') throw new Error('Unsupported Desktop prompt schema');
      this.tools.set(name, tool);
    }
    this.optionalToolErrors = new Map();
    for (const [name, variants] of [
      ['list_projects', [{}]],
      ['create_thread', [createArguments('project-id', 'prompt'), createArguments(null, 'prompt')]],
    ]) {
      const tool = result.tools.find(t => t.name === name);
      if (tool?.namespace && variants.some(args => accepts(tool.inputSchema, args))) this.tools.set(name, tool);
      else this.optionalToolErrors.set(name, `Desktop 新建聊天功能不可用：${name} schema 缺失或不兼容，请运行 doctor`);
    }
    const data = await this.read(this.connection.callerThreadId, { turnLimit: 1, includeOutputs: false });
    return { thread: data.thread, tools: Object.fromEntries([...this.tools].map(([k, v]) => [k, v.inputSchema])) };
  }
  async call(name, args, connection = this.connection) {
    if (!ALLOWED.includes(name) || !this.tools?.has(name)) throw new Error(this.optionalToolErrors?.get(name) || 'Desktop tool unavailable; run doctor');
    if (name === 'create_thread' && !accepts(this.tools.get(name).inputSchema, args)) {
      throw new Error('Desktop 新建聊天功能不可用：当前创建类型的 schema 不兼容，请运行 doctor');
    }
    const result = await this.pipe.request('tools/call', {
      arguments: args, callerSource: 'codex', callId: `wechat-${randomUUID()}`,
      hostId: connection.hostId, namespace: this.tools.get(name).namespace,
      threadId: connection.callerThreadId, tool: name,
      turnId: connection.callerTurnId || `wechat-${randomUUID()}`,
    });
    if (result.success !== true) {
      if (result.success === false && name === 'read_thread' && result.contentItems?.some(c => c.type === 'inputText' &&
        c.text?.startsWith('Tool response exceeds the size limit.'))) {
        throw Object.assign(new Error('桌面返回内容过大，请在 Codex 查看该聊天'), { code: 'DESKTOP_RESPONSE_TOO_LARGE' });
      }
      // Calibrated against the current Desktop's explicit not-found reply, not transport timeouts.
      if (result.success === false && name === 'read_thread' && result.contentItems?.some(c => c.type === 'inputText' &&
        c.text?.startsWith(`No Codex thread found for threadId: ${args.threadId}. Hosts without a readable match:`))) {
        throw Object.assign(new Error('目标聊天不存在或当前不可读取，请先在桌面确认'), { code: 'TARGET_UNAVAILABLE' });
      }
      throw Object.assign(new Error(JSON.stringify(result.contentItems)),
        result.success === false ? { code: 'DESKTOP_TOOL_REJECTED' } : {});
    }
    const texts = result.contentItems?.filter(c => c.type === 'inputText').map(c => c.text);
    if (texts?.length !== 1) throw new Error('Unsupported Desktop response content');
    return JSON.parse(texts[0]);
  }
  async read(threadId, options = {}, connection = this.connection) {
    const args = { hostId: 'local', threadId, turnLimit: 10,
      includeOutputs: true, maxOutputCharsPerItem: 18000, ...options };
    let data;
    try { data = await this.call('read_thread', args, connection); }
    catch (error) {
      // Retry only this explicitly rejected read. Keep the cursor, outputs and caller;
      // the returned page tells observation where to continue without skipping turns.
      if (error.code !== 'DESKTOP_RESPONSE_TOO_LARGE' || !(args.turnLimit > 1)) throw error;
      data = await this.call('read_thread', { ...args, turnLimit: 1 }, connection);
    }
    if (data.thread?.id !== threadId || data.thread?.hostId !== 'local' || data.thread?.kind !== 'codex') {
      throw Object.assign(new Error('Desktop target is not the expected local main chat'), { code: 'TARGET_UNAVAILABLE' });
    }
    return data;
  }
  list(args = {}) { return this.call('list_threads', args); }
  projects() { return this.call('list_projects', {}); }
  canCreate(projectId = 'project-id') { return accepts(this.tools?.get('create_thread')?.inputSchema, createArguments(projectId, 'prompt')); }
  create(projectId, prompt) {
    if (projectId !== null && (typeof projectId !== 'string' || !projectId.trim()) || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('新建聊天需要有效项目 ID（无项目时为 null）和非空首条要求');
    }
    return this.call('create_thread', createArguments(projectId, prompt));
  }
  send(threadId, prompt) { return this.call('send_message_to_thread', { hostId: 'local', threadId, prompt }); }
  close() { this.pipe.close(); }
}

export function callerFromMetadata(meta = {}) {
  let turn;
  const raw = meta['x-codex-turn-metadata'];
  if (typeof raw === 'string') { try { turn = JSON.parse(raw); } catch { /* fail closed below */ } }
  else if (raw && typeof raw === 'object') turn = raw;
  const threadId = meta['openai/threadId'] ?? meta['openai/thread_id'] ?? turn?.thread_id;
  const turnId = meta['openai/turnId'] ?? meta['openai/turn_id'] ?? turn?.turn_id;
  if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('Missing trusted calling-chat metadata; cannot use CODEX_THREAD_ID as fallback');
  return { threadId, ...(typeof turnId === 'string' ? { turnId } : {}) };
}
