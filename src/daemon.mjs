import http from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { appendFile, mkdir, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonStore, writeJsonAtomic } from './state-store.mjs';
import { acquireOwnership, defaultDataDir, secureDirectory } from './local-runtime.mjs';
import { WeixinClient } from './weixin-client.mjs';
import { Bridge, INITIAL_STATE } from './bridge.mjs';
import { isDesktopToolRejection } from './desktop-client.mjs';

function sameSecret(a, b) {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startDaemon({ dir = defaultDataDir(), weixin = new WeixinClient(), desktopFactory, loop = true } = {}) {
  await secureDirectory(dir);
  const ownership = await acquireOwnership(dir);
  let server, bridge, runtime;
  const controller = new AbortController();
  const tasks = new Set();
  const handlers = new Set();
  let closing;
  const track = promise => { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; };
  async function log(event, fields = {}) {
    await appendFile(join(dir, 'logs', 'bridge.log'), JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 });
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try {
        controller.abort();
        bridge?.close();
        server?.close();
        server?.closeIdleConnections();
        await Promise.allSettled([...handlers]);
        await Promise.allSettled([...tasks]);
        if (bridge) await Promise.allSettled([...bridge.threadQueues.values()]);
        if (runtime) {
          let saved;
          try { saved = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
          if (saved?.instanceId === runtime.instanceId) await unlink(join(dir, 'runtime.json'));
        }
      } finally { await ownership.release(); }
    })();
    return closing;
  }
  try {
    await mkdir(join(dir, 'logs'), { recursive: true, mode: 0o700 });
    const state = new JsonStore(join(dir, 'state.json'), INITIAL_STATE);
    const credentials = new JsonStore(join(dir, 'credentials.json'), {});
    const config = new JsonStore(join(dir, 'config.json'), { version: 1 });
    const loaded = await Promise.allSettled([state.load(), credentials.load(), config.load()]);
    const failedLoad = loaded.find(result => result.status === 'rejected');
    if (failedLoad) throw failedLoad.reason;
    if (state.read().version !== 1 || !state.read().chats || !Array.isArray(state.read().inbound)) throw new Error('Unsupported bridge state; refusing reset');
    bridge = new Bridge({ state, credentials, config, weixin, desktopFactory, log });
    await bridge.init();
    let login = null;
    async function loginPoll(session) {
      try {
        while (!controller.signal.aborted && login === session && Date.now() - session.createdAt < 5 * 60_000) {
          const verifyCode = session.verifyCode;
          delete session.verifyCode;
          let result;
          try { result = await weixin.pollQr(session.qrcode, { signal: controller.signal, verifyCode }); }
          catch (e) { if (controller.signal.aborted) return; session.error = `登录请求失败 (${e.code || 'NETWORK'})，可重新运行 login`; session.status = 'error'; return; }
          session.status = result.status === 'confirmed' ? 'saving' :
            result.status === 'need_verifycode' && session.verifyCode ? 'verifying' : result.status;
          if (result.status === 'confirmed') {
            const fields = ['bot_token', 'ilink_bot_id', 'ilink_user_id', 'baseurl'];
            if (fields.some(k => typeof result[k] !== 'string' || !result[k])) throw new Error('登录缺少账号字段');
            const old = credentials.read();
            if (old.userId && (old.userId !== result.ilink_user_id || old.botId !== result.ilink_bot_id)) throw new Error('扫码账号与本机已绑定账号不同，未覆盖原绑定');
            await credentials.update(c => {
              c.botToken = result.bot_token; c.botId = result.ilink_bot_id; c.userId = result.ilink_user_id;
              c.baseUrl = result.baseurl; delete c.contextToken;
            });
            await config.update(c => { delete c.boundAt; });
            delete bridge.errors.auth;
            delete session.qrcode;
            await log('login_confirmed');
            session.status = 'confirmed';
            return;
          }
          if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) return;
          await delay(1000, undefined, { signal: controller.signal }).catch(() => {});
        }
        if (login === session && session.status !== 'confirmed') session.status = 'expired';
      } catch (e) { session.status = 'error'; session.error = e.message; }
    }
    const routes = {
      '/health': async () => ({ service: 'wechatbot', version: '0.1.0', pid: process.pid, startedAt: ownership.owner.startedAt }),
      '/status': async () => bridge.status(),
      '/doctor': async () => {
        let desktopCheck;
        try {
          const checked = await bridge.requireDesktop().validate();
          delete bridge.errors.desktop;
          desktopCheck = { compatible: true, tools: Object.keys(checked.tools) };
        } catch (error) {
          if (isDesktopToolRejection(error)) delete bridge.errors.desktop;
          else bridge.errors.desktop = '当前桌面连接或必要 schema 校准未通过';
          desktopCheck = { compatible: false, ...(isDesktopToolRejection(error) ? { errorCode: error.code } : {}) };
        }
        return { ...bridge.status(), desktopCheck, codeVersion: bridge.connection?.codeVersion || process.env.CODEX_VERSION || 'unknown' };
      },
      '/register': async body => {
        if (!body.connection || typeof body.connection.pipePath !== 'string' || !body.connection.pipePath.startsWith('\\\\.\\pipe\\')) throw new Error('Expected Windows Desktop named pipe');
        return bridge.register(body.connection);
      },
      '/desktop-discovery': async body => {
        const candidate = state.read().desktopCandidate;
        if (!candidate) return { registered: false, reason: 'awaiting_first_trusted_call' };
        if (typeof body.pipePath !== 'string' || !body.pipePath.startsWith('\\\\.\\pipe\\') || body.hostId !== 'local') throw new Error('Expected local Desktop pipe');
        await bridge.register({ ...candidate, pipePath: body.pipePath, hostId: body.hostId });
        return { registered: true };
      },
      '/mcp': async body => {
        if (!['wechat_set_notifications', 'wechat_select_current_chat', 'wechat_status'].includes(body.tool)) throw new Error('Unknown MCP tool');
        const caller = body.caller;
        if (!caller || typeof caller.threadId !== 'string' || !caller.threadId.trim() ||
          caller.turnId !== undefined && typeof caller.turnId !== 'string') throw new Error('Missing MCP calling identity');
        if (body.connection !== undefined) {
          const connection = body.connection;
          if (!connection || connection.callerThreadId !== caller.threadId || connection.callerTurnId !== caller.turnId) throw new Error('MCP connection calling identity mismatch');
          if (typeof connection.pipePath !== 'string' || !connection.pipePath.startsWith('\\\\.\\pipe\\') || connection.hostId !== 'local') throw new Error('Expected local Desktop pipe');
          await bridge.register(connection);
        }
        const connection = body.connection || { ...bridge.connection, callerThreadId: caller.threadId, callerTurnId: caller.turnId };
        if (body.tool === 'wechat_set_notifications') return bridge.setNotifications(caller.threadId, body.arguments?.enabled, connection);
        if (body.tool === 'wechat_select_current_chat') return bridge.select(caller.threadId, connection);
        await bridge.chatCurrent(caller.threadId, connection);
        return { ...bridge.status(), caller, chat: state.read().chats[caller.threadId] };
      },
      '/notifications': async () => state.read().notifications.map(n => ({ id: n.id, status: n.status, text: n.text, error: n.error, transport: n.transport })),
      '/retry-notification': async body => { await bridge.retryNotice(body.id); return { queued: true }; },
      '/login/start': async () => {
        if (login && !['confirmed', 'error', 'expired', 'verify_code_blocked', 'binded_redirect'].includes(login.status)) throw new Error('已有登录等待扫码，请先使用 login-status');
        login = { id: randomUUID(), createdAt: Date.now(), status: 'starting' };
        let qr;
        try { qr = await weixin.getQr(); } catch (e) { login.status = 'error'; login.error = '获取二维码失败，请重新运行 login'; throw e; }
        if (typeof qr.qrcode !== 'string' || typeof qr.qrcode_img_content !== 'string') throw new Error('微信未返回可用二维码');
        login.qrcode = qr.qrcode; login.status = 'wait';
        track(loginPoll(login));
        return { id: login.id, payload: qr.qrcode_img_content, status: login.status };
      },
      '/login/status': async () => login ? { id: login.id, status: login.status, error: login.error } : { status: 'none' },
      '/login/verify': async body => {
        if (!login || login.status !== 'need_verifycode') throw new Error('当前不需要验证码');
        if (typeof body.code !== 'string' || !body.code.trim() || body.code.length > 64) throw new Error('无效验证码');
        login.verifyCode = body.code.trim(); login.status = 'verifying'; return { accepted: true };
      },
      '/stop': async () => { setTimeout(() => close().catch(() => {}), 20); return { stopping: true }; },
    };
    const token = randomBytes(32).toString('base64url');
    async function handleRequest(req, res) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      const respond = (status, value) => { res.statusCode = status; res.end(JSON.stringify({ instanceId: ownership.owner.instanceId, ...value })); };
      // Browser-originated requests are not a supported control channel.
      if (req.method !== 'POST' || req.headers.origin || !sameSecret(req.headers.authorization, `Bearer ${token}`) || req.headers['x-wechatbot-instance'] !== ownership.owner.instanceId) return respond(403, { error: 'Local authorization failed' });
      const route = routes[req.url];
      if (!route) return respond(404, { error: 'Unknown local endpoint' });
      try {
        let length = 0;
        const chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 256 * 1024) throw new Error('Local request too large');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const result = await route(body);
        respond(200, { result });
      } catch (e) { respond(400, { error: e.message }); }
    }
    server = http.createServer((req, res) => {
      if (closing) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ instanceId: ownership.owner.instanceId, error: 'Daemon is stopping' })); return; }
      const task = handleRequest(req, res);
      handlers.add(task);
      task.finally(() => handlers.delete(task)).catch(() => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    runtime = { ...ownership.owner, host: '127.0.0.1', port: server.address().port, token };
    await writeJsonAtomic(join(dir, 'runtime.json'), runtime);
    await log('daemon_started', { instanceId: runtime.instanceId, pid: process.pid });
    if (loop) {
      track((async () => {
        let backoff = 1000;
        while (!controller.signal.aborted) {
          const creds = credentials.read();
          if (!creds.botToken || bridge.errors.auth) { await delay(1000, undefined, { signal: controller.signal }).catch(() => {}); continue; }
          try {
            const batch = await weixin.getUpdates(creds, state.read().cursor, { signal: controller.signal });
            if (controller.signal.aborted) break;
            await bridge.acceptBatch({ ...batch, msgs: batch.msgs || [], get_updates_buf: batch.get_updates_buf ?? state.read().cursor });
            backoff = 1000;
            await bridge.processInbound();
            bridge.dispatchReady();
            if (!(batch.msgs?.length)) await delay(500, undefined, { signal: controller.signal }).catch(() => {});
          } catch (e) {
            if (controller.signal.aborted) break;
            if (e.category === 'auth') bridge.errors.auth = '微信登录失效，请重新扫码';
            else bridge.errors.receive = '微信接收暂时失败，保留游标后重试';
            await log('receive_error', { code: e.code || 'LOCAL', category: e.category || 'local' });
            await delay(backoff, undefined, { signal: controller.signal }).catch(() => {});
            backoff = Math.min(30000, backoff * 2);
          }
        }
      })());
      track((async () => {
        let ticks = 0;
        while (!controller.signal.aborted) {
          try {
            await bridge.processInbound();
            bridge.dispatchReady();
            await bridge.observe();
            await bridge.sendPending();
            if (++ticks % 100 === 0) await bridge.maintain();
          } catch { await log('work_cycle_error'); }
          await delay(3000, undefined, { signal: controller.signal }).catch(() => {});
        }
      })());
    }
    return { runtime, bridge, close };
  } catch (e) { await close(); throw e; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const daemon = await startDaemon();
    process.on('SIGINT', () => daemon.close().catch(() => {}));
    process.on('SIGTERM', () => daemon.close().catch(() => {}));
  } catch (e) { console.error(`WeChatBot start failed: ${e.message}`); process.exitCode = 1; }
}
