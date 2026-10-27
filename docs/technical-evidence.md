# Windows Codex Desktop ↔ 微信桥接：技术证据与待验证边界

研究日期：2026-10-27。仅研究；未安装、扫码、发微信、实现服务或修改 Codex 配置。
目标：单个本机 Windows 用户、单个微信账号；稳定编号选择已有聊天并继续。
通知已由用户确认：按聊天开启；开启后该聊天每次执行结束都通知，直到关闭。
完成观察只覆盖已订阅聊天和微信发起的轮次，不扫描所有历史正文。

## 证据分层

- **本会话既有实测（父任务提供）**：内部 AppTools pipe 可调用 `send_message_to_thread`；
  对 active、idle 聊天均能继续同一聊天，`read_thread` 可读到 `final_answer` 与 completed。
- 上述消息是工具转达路径，不能等同于桌面输入框直接提交；业务表现需保留此差异。
- **本机最新只读事实（父任务提供）**：`CODEX_VERSION=0.164.0-alpha.11.1`；
  当前 bundled AppTools 为 `26.1021.31345/server.mjs`，仍有 `x-codex-turn-metadata`、
  `CODEX_APP_TOOLS_PIPE_PATH`；旧 `0.1.6` 目录已不在当前 cache。
- 当前版本只读发现不等于重新完成了所有旧版本端到端测试；升级后的连接与行为仍需复核。
- **上游源码**：Tencent `874637a0dbc24050f72d1385add4fc6170a2d726`；
  AgentPet `86c6fb6ef378e1778c88456be0de2c70ff443f70`。
- 以下建议是依据源码做的最小实现取舍，不是供应方稳定性承诺。

## 1. 微信认证、主动通知与限制

- Tencent 自述协议来自当前客户端实现，特别说明：可选类型字段和客户端行为不代表完整服务端契约。
  [协议范围与限制](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md)
- 登录流程：取二维码、轮询状态，confirmed 返回 `bot_token`、bot id、user id 和 `baseurl`。
  普通请求使用 HTTPS JSON、Bearer bot token；应保存登录返回的 base URL。
  [二维码流程与鉴权](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts)
- `bot_token` 是账号鉴权；`context_token` 是入站消息携带的回复上下文，二者不可替换。
  最新入站 token 按 account + user 保存并持久化，重启恢复；存储代码没有 TTL 字段。
  [token 缓存](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts)
- 文本通知通过 `sendmessage`，含收件人、client id、完成态和上下文 token。
  当前 helper 缺 token 时只警告仍发送；这不证明服务端接受无 token 主动发送。
  [文本发送](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts)
- 所查一手资料没有给出 context token 的确切有效期、允许主动发送的时窗或每分钟/每天额度。
  不能承诺“扫码后永久通知”，也不能把第三方“24 小时”等经验写成规则。
  [协议的明确边界](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md)
- `-14` 被上游解释为 bot token stale/expired；客户端暂停账号调用一小时。
  一小时是客户端退避时长，不是 token 寿命，也不证明等待一小时必然恢复。
  [session guard](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/session-guard.ts)
- `getupdates` 保存并回传游标，默认长轮询 35 秒，接受服务器返回的轮询超时建议。
  上游的重试退避是客户端策略，不等于服务端限流配额。
  [monitor](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts)
- 最小建议：先让本人向机器人发消息以取得上下文；通知沿用最新 token。
  发送失败明确记录与展示，保留聊天订阅；不盲目循环发送，也不在规划阶段承诺无限期主动推送。
- 待实测：隔时通知、账号重登后的 token、失效返回码、短时少量连续通知、长文本边界。
  这些是一次小范围真实账号验收，不要求搭建自动恢复平台。

## 2. 原聊天继续：内部 AppTools 与 follower IPC

- AppTools 是本会话已有成功证据最强的候选，但属于桌面内部接口。
  需分别验证：外部本地进程连接、必要上下文/metadata、当前版本 active 与 idle 行为、重启重发现。
- 不硬编码 plugin cache 的版本路径；pipe 名与上下文从当前运行实例发现。
  `CODEX_APP_TOOLS_PIPE_PATH` 是已观察到的连接线索，不是公开支持的发现协议。
- AgentPet 源码给出另一路 Windows named pipe `codex-ipc`：4 字节小端长度帧 + UTF-8 JSON，
  `initialize` 后 `thread-owner-discovery` v1，再定向 `thread-follower-start-turn` v2。
  它自注适配 Desktop 26.1013，不能视为本机新版本已验证。
  [IPC client](https://github.com/wy1003/agent-pet/blob/86c6fb6ef378e1778c88456be0de2c70ff443f70/desktop/codex-desktop-client.mjs)
- follower 输入包含 `threadId`、`clientUserMessageId`、cwd，文本项还包含 `text_elements: []`。
  executor 收到明确 turn id 后才认为提交已确认，之后按这个 turn id 观察完成。
  [executor](https://github.com/wy1003/agent-pet/blob/86c6fb6ef378e1778c88456be0de2c70ff443f70/desktop/codex-desktop-executor.mjs)
- **权限不能照抄**：该 executor 同时传 `inheritThreadSettings: true`、
  `useAppServerPermissionDefault: false`，并显式设置 approvalPolicy=never、
  permissions=null、workspaceWrite、networkAccess=false。
  仅凭这些字段无法证明“完整继承原聊天权限”；也不能复制后声称权限不变。
  [请求原文](https://github.com/wy1003/agent-pet/blob/86c6fb6ef378e1778c88456be0de2c70ff443f70/desktop/codex-desktop-executor.mjs)
- 忙时：现有 AppTools 实测支持 active 聊天转达，但 follower 源码没有给出 owner 忙时的普遍保证。
  是否排队、插入当前轮次、拒绝，以及如何关联结束事件，必须用本机边界测试区分。
- 不重复写入原则：微信入站 message id 持久化去重；每次仅选一条提交路径。
  一旦请求已派发却未确认，先检查原聊天；不要自动改走 CLI/SDK 或另一 IPC 再发一次。
  AgentPet 本身也在 dispatch 后禁止 fallback。
  [未知提交结果处理](https://github.com/wy1003/agent-pet/blob/86c6fb6ef378e1778c88456be0de2c70ff443f70/desktop/codex-desktop-executor.mjs)
- `clientUserMessageId` / requestId 的存在不是服务端幂等保证；当前资料未证明其去重契约。
- 最小建议：优先复核已成功的 AppTools；follower 作为单独评估候选。
  原聊天归属不可确认时提示桌面打开聊天；不为了“可用”自动启动另一个写入者。

## 3. 聊天列表与每轮完成的最小观测

| 途径 | 已有依据 | 对本任务的边界 |
| --- | --- | --- |
| 内部 AppTools | 本会话 list/read/wait/send 工具能力和旧实测 | 优先候选；外部连通与重启发现仍须验证 |
| 公开 app-server | 官方有 thread/list、read、turn/completed | 新开进程不等于已连接桌面拥有者；不能据此保证接管现有 UI 聊天 |
| 本地 JSONL | AgentPet 读取 sessions 与 session_index | 仅只读观察候选，格式随版本变化；不修改 Codex 历史 |

官方 app-server 的 thread/list 可分页，read 无需 resume；turn/completed 区分 completed/interrupted/failed。
公开资料没有在该页建立 Windows Desktop 内部 pipe 的连接契约。
[OpenAI 官方 app-server 文档](https://developers.openai.com/codex/app-server/)

- AgentPet 通过 session_index 的 id/thread_name 补标题，从 session_meta 取会话身份；
  collector 递归扫描 JSONL、保存文件偏移并保留未完整的末行，默认排除 subagent。
  可借鉴解析点，不复制其全目录持续扫描与桌宠可见性状态。
  [collector](https://github.com/wy1003/agent-pet/blob/86c6fb6ef378e1778c88456be0de2c70ff443f70/src/collector.mjs)
- 完成以同一 thread + turn 的生命周期结束为准；`final_answer` 是答案内容信号，不能单独代替执行结束。
  AgentPet 处理 task_complete、turn_aborted；task_complete 若含 error 优先视失败。
  [model](https://github.com/wy1003/agent-pet/blob/86c6fb6ef378e1778c88456be0de2c70ff443f70/src/model.mjs)
- 编号由桥接自身持久化 `编号 → hostId/threadId`，不按最新排序重新编号；标题只作显示。
  列表按需分页；订阅聊天保存通知开关与最后处理 turn，通知去重按 thread + turn。
- 启动时恢复编号与订阅；为每个订阅聊天确定当前观察基线，区分新结束与历史结束。
  若采用 JSONL，只定位相关聊天文件并增量读，不回放所有历史消息。
- Codex 或桥接重启后：重连当前实例、重查聊天归属和进行中 turn；旧 pipe、旧 client id、旧 bundle 路径不能沿用。
  重启期间漏掉或无法确认的轮次要显式显示未知；不自动补发历史通知制造重复。
- 必须验收：桌面发起的新轮次也能被订阅捕获；关闭订阅后停止；失败/中断能区分；
  桌面重启/桥接重启后编号不变；未订阅聊天不产生完成通知；不会把子代理完成误当父聊天完成。

## 4. 可复用范围与许可证

- Tencent/openclaw-weixin 与 wy1003/agent-pet 均为 MIT，可按许可证条件提取相关代码，
  复制或实质复用时保留相应版权及许可声明。
  [Tencent LICENSE](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/LICENSE)、
  [AgentPet LICENSE](https://github.com/wy1003/agent-pet/blob/86c6fb6ef378e1778c88456be0de2c70ff443f70/LICENSE)
- 合适参考：微信 QR/HTTP 结构、token/cursor 持久化、文本构造；IPC framing 与 owner discovery；
  JSONL 身份/轮次/末行解析。OpenClaw 插件包装及 AgentPet UI、额外模型、SDK fallback 不属于本任务。
- MIT 源码许可不等于微信服务可用性或 Codex 内部接口兼容承诺；产品接入资格与实机结果另行验证。

## 实施前应关闭的最小缺口

1. 当前桌面版本的外部 AppTools 连接、身份上下文、active/idle 提交与原聊天权限。
2. 单个已订阅聊天从桌面启动的轮次，能按 turn 确认成功、失败、中断并只通知一次。
3. 微信延迟通知的真实 token 行为；当前官方资料不足以保证任意时长主动通知。
4. 两端重启后能重新发现连接、恢复稳定编号，未知提交结果不会被自动重发。

以上关闭前可完成方案与原型验证计划，不应把源码推断写成已实现、已上线或长期可靠保证。
