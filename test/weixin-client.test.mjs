import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinClient, WeixinError, normalizeInbound } from '../src/weixin-client.mjs';

const credentials = { botToken: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'bot-account', userId: 'owner' };
const outbound = { toUserId: 'owner', text: '测试\n通知', clientId: 'stable-id', contextToken: 'context' };
const inbound = { message_id: '18446744073709551615', from_user_id: 'owner', to_user_id: 'bot-account', message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: '帮助' } }], context_token: 'context' };
function fixture(raw = { ret: 0 }, status = 200) {
  const requests = [];
  const client = new WeixinClient({ fetchImpl: async (url, options) => {
    requests.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    return new Response(typeof raw === 'string' ? raw : JSON.stringify(raw), { status });
  } });
  return { client, requests };
}

test('QR request matches official headers and body; polling encodes secret and omits auth', async () => {
  const { client, requests } = fixture({ qrcode: 'a&b', qrcode_img_content: 'qr-content' });
  assert.equal((await client.getQr()).qrcode, 'a&b');
  await client.pollQr('a&b', { verifyCode: '12 34' });
  assert.equal(requests[0].url, `${credentials.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.deepEqual(requests[0].body, { local_token_list: [] });
  assert.equal(requests[0].headers['iLink-App-ClientVersion'], '132106');
  assert.equal(requests[0].headers.AuthorizationType, 'ilink_bot_token');
  assert.match(Buffer.from(requests[0].headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[1].url, `${credentials.baseUrl}/ilink/bot/get_qrcode_status?qrcode=a%26b&verify_code=12+34`);
  assert.deepEqual(requests[1].headers, { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106' });
});

test('updates preserve large wire IDs and cursor; caller gets raw fields', async () => {
  const { client, requests } = fixture('{"ret":0,"msgs":[{"message_id":18446744073709551615}],"get_updates_buf":"next"}');
  const raw = await client.getUpdates(credentials, 'previous');
  assert.equal(raw.msgs[0].message_id, '18446744073709551615');
  assert.equal(raw.get_updates_buf, 'next');
  assert.deepEqual(requests[0].body, { get_updates_buf: 'previous', base_info: { channel_version: '2.4.10', bot_agent: 'WeChatBot/0.1.0' } });
  assert.equal(requests[0].headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].redirect, 'error');
});

test('send requires explicit HTTP and ret=0 and constructs finished text', async () => {
  const { client, requests } = fixture({ ret: 0, message_id: '123' });
  assert.deepEqual(await client.sendText(credentials, outbound), { ret: 0, message_id: '123' });
  assert.deepEqual(requests[0].body.msg, { from_user_id: '', to_user_id: 'owner', client_id: 'stable-id', message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: '测试\n通知' } }], context_token: 'context' });
  for (const receipt of [{}, { ret: '0' }, { ret: 0, errcode: 'unexpected' }]) {
    await assert.rejects(fixture(receipt).client.sendText(credentials, outbound), { category: 'unknown' });
  }
  await assert.rejects(fixture({ ret: 0 }, 500).client.sendText(credentials, outbound), { code: 'HTTP_500', category: 'unknown' });
});

test('real message_id-only success receipt is accepted without weakening unknown or contradictory receipts', async () => {
  const raw = '{"message_id":18446744073709551615}';
  assert.deepEqual(await fixture(raw).client.sendText(credentials, outbound), { message_id: '18446744073709551615' });
  for (const receipt of [{ message_id: '0' }, { message_id: '' }, { message_id: '18446744073709551616' },
    { message_id: '10', ret: '0' }, { message_id: '10', errmsg: 'error' }, { errcode: 0 }, {}]) {
    await assert.rejects(fixture(receipt).client.sendText(credentials, outbound), { category: 'unknown' });
  }
  await assert.rejects(fixture({ message_id: '10', ret: -99 }).client.sendText(credentials, outbound), { code: -99, category: 'rejected' });
});

test('only confirmed auth codes classified; other explicit server rejection is not context', async () => {
  for (const raw of [{ ret: -14 }, { ret: 0, errcode: -14 }]) {
    await assert.rejects(fixture(raw).client.sendText(credentials, outbound), { code: -14, category: 'auth' });
  }
  await assert.rejects(fixture({ ret: -99, errmsg: 'secret context expired' }).client.sendText(credentials, outbound), error => error instanceof WeixinError && error.category === 'rejected' && !error.message.includes('secret'));
  await assert.rejects(fixture({ errcode: -14 }).client.getUpdates(credentials, ''), { category: 'auth' });
});

test('network, body read, malformed receipts and abort remain unknown, never retried', async () => {
  for (const fetchImpl of [async () => { throw Error('token secret'); }, async () => ({ ok: true, text: async () => { throw Error('read'); } })]) {
    let calls = 0;
    const client = new WeixinClient({ fetchImpl: (...args) => { calls++; return fetchImpl(...args); } });
    await assert.rejects(client.sendText(credentials, outbound), { category: 'unknown' });
    assert.equal(calls, 1);
  }
  for (const raw of ['invalid', 'null', '[]']) await assert.rejects(fixture(raw).client.sendText(credentials, outbound), { category: 'unknown' });
  const controller = new AbortController(); controller.abort();
  const client = new WeixinClient({ fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); } });
  await assert.rejects(client.sendText(credentials, outbound, { signal: controller.signal }), { code: 'ABORTED', category: 'unknown' });
});

test('network diagnostics preserve safe cause and request stage without exposing tokens, URLs or error text', async () => {
  const networkError = new TypeError('secret-token https://secret.example');
  networkError.cause = Object.assign(new Error('secret-context'), { code: 'ECONNRESET' });
  for (const bodyStage of [false, true]) {
    let calls = 0;
    const client = new WeixinClient({ fetchImpl: async () => {
      calls++;
      if (bodyStage) return { ok: true, text: async () => { throw networkError; } };
      throw networkError;
    } });
    await assert.rejects(client.sendText(credentials, outbound), e => {
      assert.equal(e.code, 'NETWORK');
      assert.equal(e.transport.stage, bodyStage ? 'response_body' : 'fetch');
      assert.equal(e.transport.httpHeadersReceived, bodyStage);
      assert.equal(e.transport.causeCode, 'ECONNRESET');
      assert.equal(JSON.stringify(e).includes('secret'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('unsafe endpoints, recipients and missing context are rejected before network', async () => {
  const { client, requests } = fixture();
  for (const baseUrl of ['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://ilinkai.weixin.qq.com.evil.example', 'https://user@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:444', 'https://ilinkai.weixin.qq.com/path']) {
    assert.throws(() => new WeixinClient({ baseUrl }), WeixinError);
    await assert.rejects(client.sendText({ ...credentials, baseUrl }, outbound), WeixinError);
  }
  await assert.rejects(client.sendText(credentials, { ...outbound, toUserId: 'stranger' }), { code: 'UNAUTHORIZED_RECIPIENT' });
  await assert.rejects(client.sendText(credentials, { ...outbound, contextToken: '' }), { code: 'CONTEXT_REQUIRED' });
  assert.equal(requests.length, 0);
});

test('official QR migration is validated and used only for subsequent poll', async () => {
  const { client, requests } = fixture({ status: 'scaned_but_redirect', redirect_host: 'migration.weixin.qq.com' });
  await client.pollQr('qr'); await client.pollQr('qr');
  assert.equal(new URL(requests[1].url).host, 'migration.weixin.qq.com');
  await assert.rejects(fixture({ status: 'scaned_but_redirect', redirect_host: 'evil.example' }).client.pollQr('qr'), { code: 'UNTRUSTED_BASE_URL' });
  await assert.rejects(fixture({ status: 'confirmed', baseurl: 'https://evil.example' }).client.pollQr('qr'), { code: 'UNTRUSTED_BASE_URL' });
});

test('inbound identity, account, stable IDs and final state are required; media never becomes text', () => {
  assert.deepEqual(normalizeInbound(inbound, credentials), { id: inbound.message_id, sender: 'owner', text: '帮助', contextToken: 'context', isText: true });
  for (const change of [{ from_user_id: 'stranger' }, { to_user_id: 'other-bot' }, { group_id: 'group' }, { message_type: 2 }, { message_state: 1 }, { message_id: undefined }, { message_id: Number.MAX_SAFE_INTEGER + 1 }, { item_list: null }]) assert.equal(normalizeInbound({ ...inbound, ...change }, credentials), null);
  const media = normalizeInbound({ ...inbound, item_list: [{ type: 3, voice_item: { text: '切换 #3' } }] }, credentials);
  assert.equal(media.isText, false); assert.equal(media.text, '');
  const mixed = normalizeInbound({ ...inbound, item_list: [...inbound.item_list, { type: 2 }] }, credentials);
  assert.equal(mixed.isText, false);
  assert.equal(normalizeInbound({ ...inbound, message_id: 123 }, credentials).id, '123');
  assert.equal(normalizeInbound({ ...inbound, message_id: '124' }, credentials).text, '帮助');
});
