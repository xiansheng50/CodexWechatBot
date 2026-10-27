# 微信文字适配器

适配范围：Node.js 24 内置 fetch；二维码、轮询登录状态、getupdates、文字 sendmessage。没有媒体下载、自动重试、状态存储、后台接收者或自动登录。真实扫码和手机收发尚未验证。

## 固定一手依据

Tencent/openclaw-weixin 提交 `874637a0dbc24050f72d1385add4fc6170a2d726`：

- [协议与边界](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md)
- [HTTP、headers、游标与uint64处理](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts)
- [二维码与迁移状态](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts)
- [消息字段与枚举](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts)
- [文字发送构造](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts)
- [账号失效码](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/session-guard.ts)
- [实际应用版本](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/package.json)

固定提交实际版本为 `2.4.10`，appid 为 `bot`，版本头按 major/minor/patch 字节编码为 `132106`。协议中的 `2.4.8` 仅为示例。认证 POST 带 `AuthorizationType`、Bearer bot token、随机 uint32 十进制字符串的 base64 UIN、JSON Content-Type；QR POST 不带 Bearer/base_info，QR GET 仅带应用头。base_info 采用兼容版本及真实客户端观测标识 `WeChatBot/0.1.0`。

## 接口与责任

```js
const client = new WeixinClient({ fetchImpl: fetch, baseUrl: 'https://ilinkai.weixin.qq.com' });
await client.getQr();
await client.pollQr(qrcode, { signal, verifyCode });
await client.getUpdates(credentials, cursor, { signal });
await client.sendText(credentials, { toUserId, text, clientId, contextToken }, { signal });
```

credentials 为 `{botToken, baseUrl, botId, userId, contextToken?}`；登录调用方从 confirmed 原始字段分别映射 `bot_token/baseurl/ilink_bot_id/ilink_user_id`，验证完整后保存。接口返回原始 JSON 对象；ID 字段的数值在解析时借 Node 24 reviver source 转为无损字符串。cursor 由调用方持久化；适配器不提前推进、不去重。getUpdates 原始返回仍需调用方验证消息批次与游标结构。

getQr 永远从固定官方起点取码，local_token_list 为空。pollQr 每次只做一次网络操作，返回原始状态；`scaned_but_redirect` 的合法官方 host 缓存在该二维码下，下一次 poll 使用；confirmed/expired 清除缓存。验证码通过可选 verifyCode 原文 URL 编码提交。配置 baseUrl 仅影响初始 poll，认证请求始终使用 credentials.baseUrl。二维码展示、刷新、状态提示及用户确认由 CLI 负责。

sendText 仅允许本人收件人，必须显式提供非空 contextToken 和稳定 clientId。单条文字采用 BOT=2、FINISH=2、TEXT=1；不从 credentials 隐式取陈旧上下文。HTTP 成功且明确 ret=0，或者返回合法正整数 uint64 message_id，并且没有冲突返回码或错误文本，才返回接口接受。2026-10-27 实机返回 HTTP200、仅 message_id；手机已确认先前两条相同报错路径的消息实际收到。message_id 是上游类型和发送调用方明确使用的服务端消息编号；不是将所有缺 ret 或 HTTP200 都当成功。空对象、仅 errcode=0、错误字段或无效 ID 仍为 unknown/rejected。返回不代表手机实际收到、已读或去重。clientId 不是已证实的服务端幂等保证。

脱敏形态见 [真实回执记录](weixin-real-send-receipt.json)。官方依据：[SendMessageResp](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts#L239-L244)、[服务端消息 ID 返回](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts#L579-L595)、[调用方读取 ID](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L120-L132)。

normalizeInbound(raw, credentials) 对单条原始消息工作，仅接收本人 sender、准确 bot recipient、无 group_id、USER=1、FINISH=2、有稳定 message_id 的消息；异常/未授权返回 null。安全整数转字符串，已经变成 unsafe number 的外部对象拒绝。纯文本条目按原顺序以换行连接；含任意媒体/未知条目的消息返回 isText=false、text=''，不能把语音识别文字执行为命令。上下文缺失返回 null，由调用方决定提示/待刷新，不下载媒体、不按正文去重。

## 错误与限制

WeixinError 带 code/category。已查源码仅证明 `-14` 是账号凭据失效，归 auth；HTTP 401/403 亦归 auth。其他明确非零业务码归 rejected，不猜测 token 失效。没有已确认的上下文失效业务码，因此当前不从服务端错误生成 context 类别；本地缺上下文为 CONTEXT_REQUIRED/rejected。后续仅在一手依据或脱敏真实回执证明后增加映射。

网络中断、超时、取消、HTTP 其他失败、响应读取失败、无效 JSON、发送缺失/不明 ret 都归 unknown。错误不携带服务端正文、URL、token 或底层网络异常；不会自动重发。普通请求超时15秒、长轮询35秒，计时覆盖响应体读取；调用方 signal 可取消。长轮询取消也抛出 unknown，由 daemon 根据停止信号退出，不伪造接收成功。

HTTPS origin 仅接受 `*.weixin.qq.com` 域名边界，无用户名密码、非默认端口、路径、query 或 hash；这是本项目允许的官方迁移域范围，并非声称上游列举了所有迁移主机。任何新域需核实后改允许范围。所有 fetch 使用 redirect:error，禁止 HTTP 自动迁移带出账号 token；登录返回 baseurl 和 QR redirect_host 均先校验。固定上游没有公开完整服务端契约，未知 context 时窗、隔夜通知、账号重登后的上下文、真实长文本边界仍待手机验收。

## 本地验证

`node --test test/weixin-client.test.mjs`：10项通过。替身仅在 fetch HTTP 边界，检查实际 URL/headers/body、响应分类、官方域拒绝、迁移、媒体/身份/uint64、实机 message_id-only 回执回归，以及网络错误安全诊断。真实扫码与手机收发结果另见 [验收记录](acceptance.md)，不将本地替身检查当作真实微信证据。
