import { randomBytes } from 'node:crypto';

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BASE_INFO = { channel_version: '2.4.10', bot_agent: 'WeChatBot/0.1.0' };
const ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

export class WeixinError extends Error {
  constructor(message, { code = 'UNKNOWN', category = 'unknown', transport } = {}) {
    super(message);
    this.name = 'WeixinError';
    this.code = code;
    this.category = category;
    if (transport) this.transport = transport;
  }
}

function fail(code, category = 'rejected') {
  // Never include server bodies, URLs, tokens, or network error messages.
  return new WeixinError(`Weixin request failed (${code})`, { code, category });
}

function officialBase(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_BASE_URL'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || !host.endsWith('.weixin.qq.com') ||
      url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw fail('UNTRUSTED_BASE_URL');
  }
  return url.origin;
}

function required(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw fail(code);
  return value;
}

function checkBusiness(raw, requireSuccess = false) {
  if (raw.ret === -14 || raw.errcode === -14) throw fail(-14, 'auth');
  const error = [raw.ret, raw.errcode].find(value => typeof value === 'number' && value !== 0);
  if (error !== undefined) throw fail(error);
  if (requireSuccess) {
    const id = raw.message_id;
    const hasMessageId = typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && BigInt(id) <= 18446744073709551615n;
    const validCodes = (raw.ret === undefined || raw.ret === 0) && (raw.errcode === undefined || raw.errcode === 0);
    const noErrorText = raw.errmsg === undefined || raw.errmsg === '';
    // Tencent's real successful response can contain only its generated uint64 message_id.
    // Keep empty/unrecognized responses unknown; never infer success just from HTTP 200.
    if (!validCodes || !noErrorText || (raw.ret !== 0 && !hasMessageId)) throw fail('UNRECOGNIZED_RECEIPT', 'unknown');
  }
  return raw;
}

export class WeixinClient {
  #fetch;
  #baseUrl;
  #qrHosts = new Map();
  constructor({ fetchImpl = fetch, baseUrl = DEFAULT_WEIXIN_BASE_URL } = {}) {
    this.#fetch = fetchImpl;
    this.#baseUrl = officialBase(baseUrl);
  }

  async #request(baseUrl, endpoint, { body, token, signal, timeout = 15_000 } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106' };
    const method = body === undefined ? 'GET' : 'POST';
    if (method === 'POST') {
      Object.assign(headers, {
        'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      });
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const startedAt = Date.now();
    let stage = 'fetch';
    try {
      const response = await this.#fetch(new URL(endpoint, `${officialBase(baseUrl)}/`).href, {
        method, headers, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      stage = 'response_body';
      if (!response.ok) throw fail(`HTTP_${response.status}`, response.status === 401 || response.status === 403 ? 'auth' : 'unknown');
      const text = await response.text();
      let raw;
      try {
        // Node 24 reviver source preserves uint64 IDs before rounded JS numbers escape.
        raw = JSON.parse(text, (key, value, context) => {
          if (ID_FIELDS.has(key) && typeof value === 'number') {
            if (!/^(0|[1-9][0-9]*)$/.test(context.source)) throw fail('INVALID_MESSAGE_ID', 'unknown');
            return context.source;
          }
          return value;
        });
      } catch { throw fail('INVALID_JSON', 'unknown'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('INVALID_RESPONSE', 'unknown');
      return raw;
    } catch (error) {
      if (error instanceof WeixinError) throw error;
      const code = signal?.aborted ? 'ABORTED' : controller.signal.aborted ? 'TIMEOUT' : 'NETWORK';
      const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : undefined;
      throw new WeixinError(`Weixin request failed (${code})`, { code, category: 'unknown', transport: {
        stage, httpHeadersReceived: stage === 'response_body', elapsedMs: Date.now() - startedAt,
        causeCode: safeCode(error.cause?.code) || safeCode(error.code),
      } });
    } finally { clearTimeout(timer); }
  }

  async getQr() {
    return checkBusiness(await this.#request(DEFAULT_WEIXIN_BASE_URL, 'ilink/bot/get_bot_qrcode?bot_type=3', {
      body: { local_token_list: [] },
    }));
  }

  async pollQr(qrcode, { signal, verifyCode } = {}) {
    required(qrcode, 'QRCODE_REQUIRED');
    const query = new URLSearchParams({ qrcode });
    if (verifyCode !== undefined) query.set('verify_code', required(verifyCode, 'VERIFY_CODE_REQUIRED'));
    const raw = checkBusiness(await this.#request(this.#qrHosts.get(qrcode) ?? this.#baseUrl,
      `ilink/bot/get_qrcode_status?${query}`, { signal, timeout: 35_000 }));
    if (raw.status === 'scaned_but_redirect' && raw.redirect_host) {
      const host = required(raw.redirect_host, 'INVALID_REDIRECT_HOST');
      if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw fail('INVALID_REDIRECT_HOST');
      this.#qrHosts.set(qrcode, officialBase(`https://${host}`));
    }
    if (raw.status === 'confirmed') {
      officialBase(raw.baseurl);
      this.#qrHosts.delete(qrcode);
    }
    if (raw.status === 'expired') this.#qrHosts.delete(qrcode);
    return raw;
  }

  async getUpdates(credentials, cursor = '', { signal } = {}) {
    required(credentials?.botToken, 'BOT_TOKEN_REQUIRED');
    if (typeof cursor !== 'string') throw fail('INVALID_CURSOR');
    return checkBusiness(await this.#request(credentials.baseUrl, 'ilink/bot/getupdates', {
      body: { get_updates_buf: cursor, base_info: BASE_INFO },
      token: credentials.botToken, signal, timeout: 35_000,
    }));
  }

  async sendText(credentials, { toUserId, text, clientId, contextToken }, { signal } = {}) {
    required(credentials?.botToken, 'BOT_TOKEN_REQUIRED');
    required(credentials?.userId, 'USER_ID_REQUIRED');
    if (toUserId !== credentials.userId) throw fail('UNAUTHORIZED_RECIPIENT');
    required(text, 'TEXT_REQUIRED');
    required(clientId, 'CLIENT_ID_REQUIRED');
    required(contextToken, 'CONTEXT_REQUIRED');
    return checkBusiness(await this.#request(credentials.baseUrl, 'ilink/bot/sendmessage', {
      token: credentials.botToken, signal,
      body: { msg: {
        from_user_id: '', to_user_id: toUserId, client_id: clientId,
        message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text } }], context_token: contextToken,
      }, base_info: BASE_INFO },
    }), true);
  }
}

export function normalizeInbound(raw, credentials) {
  if (!raw || typeof raw !== 'object' || !credentials?.botId || !credentials?.userId ||
      raw.from_user_id !== credentials.userId || raw.to_user_id !== credentials.botId ||
      raw.group_id || raw.message_type !== 1 || raw.message_state !== 2) return null;
  const id = raw.message_id;
  if (!(typeof id === 'string' && /^(0|[1-9][0-9]*)$/.test(id)) &&
      !(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) return null;
  if (!Array.isArray(raw.item_list) || raw.item_list.length === 0) return null;
  const isText = raw.item_list.every(item => item?.type === 1 && typeof item.text_item?.text === 'string');
  return {
    id: String(id), sender: raw.from_user_id,
    text: isText ? raw.item_list.map(item => item.text_item.text).join('\n') : '',
    contextToken: typeof raw.context_token === 'string' && raw.context_token ? raw.context_token : null,
    isText,
  };
}
