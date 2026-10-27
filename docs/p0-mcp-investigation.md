# P0：自定义 MCP 的身份、环境和重载边界

日期：2026-10-27。只读调查；未改 Codex 配置、未重启桌面、未发送聊天消息、未启动额外 Codex 执行器。使用 OpenAI Docs 技能查阅官方文档，并检查本机安装包。没有执行自定义 MCP 的真实调用，因此本报告不能关闭“两聊天身份正确”的验收项。

## 结论

1. **可信的逐调用聊天身份尚未证明可用于普通第三方 stdio MCP。** bundled AppTools 会消费 `request.params._meta` 中的身份，但消费者代码不是通用 MCP 发送端证据。也没有证据可据此断言该 metadata 仅供 bundled 服务使用。
2. **pipe 可以通过显式 `env_vars` 转发的方案值得实测，不应依赖默认继承。** bundled 配置自己显式允许 `CODEX_APP_TOOLS_PIPE_PATH`；桌面主进程创建 pipe 并设置运行时环境。当前 shell 可见此变量，只证明 exec 环境可见。
3. **存在无须重启 app-server 的官方 MCP 重载方法 `config/mcpServer/reload`，会排队刷新已加载聊天。** 但尚未证明第三方客户端如何连接当前桌面拥有的 app-server 并调用它；bundled AppTools 也未因此自动提供任意 app-server RPC。不能写成已有可用的 `codex mcp reload` 命令。

## 当前版本与命令证据

本机有两份 CLI，必须区分：

```powershell
Get-Command codex | Select-Object Source
# C:\Users\Administrator\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe
codex --version
# codex-cli 0.149.1
& 'C:/Users/Administrator/AppData/Local/OpenAI/Codex/bin/2993767bd1dfb009/codex.exe' --version
# codex-cli 0.164.0-alpha.11.1
```

`Get-CimInstance Win32_Process` 的运行进程路径确认桌面实际使用后者。后者 `mcp --help` 只有 list/get/add/remove/login/logout/help，没有 reload。`debug app-server --help` 只有 send-message-v2/help，未找到连接既有桌面后执行任意 RPC 的公开 CLI 入口；未执行 send-message-v2。

## bundled AppTools 的直接证据

以下 `B` 代表本机文件：

`C:/Users/Administrator/.codex/plugins/cache/openai-bundled/codex-app-tools/26.1021.31345`。

| 文件与行号 | 观察 | 能证明的范围 |
| --- | --- | --- |
| `B/server.mjs:29994-29997` | turn metadata schema 接受 thread_id、turn_id | bundled 消费者支持这两个字段 |
| `B/server.mjs:30044-30059` | 读 params._meta；依次取 openai/threadId 等别名、x-codex-turn-metadata.thread_id、nested thread.id；缺失报错 | 需要 executor 的调用身份；不能据此证明普通 MCP 被发送这些字段 |
| `B/server.mjs:30064-30089` | 转发 tools/call，包含 callerSource、hostId、threadId、turnId、callId | pipe 请求必须保留调用上下文 |
| `B/server.mjs:30157,30174-30175` | pipe 环境变量、caller host、deferred 环境开关 | bundled 服务的运行时依赖 |
| `B/server.mjs:30188-30200` | 从环境读 pipe，缺失报 ConnectionClosed | 不会自行发现当前桌面 pipe |
| `B/.mcp.json:37-48` | env_vars 明确包含 CODEX_APP_TOOLS_PIPE_PATH 等 | bundled 启动配置显式转发，不能假设任意自定义 MCP 自动获得 |

这里没有对 metadata 做密码学验签；“可信”应指由 Codex 的实际调用传输附加并与目标原聊天核对，而不是让模型在工具 arguments 填 thread ID。也不能把常驻进程的固定 CODEX_THREAD_ID 当逐调用身份。

## 桌面安装包中的证据

安装包：`C:/Program Files/WindowsApps/OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0/app/resources/app.asar`。

使用 Python 只读解析 ASAR：前 16 字节为四个 little-endian uint32，JSON header 长度取第 4 个值；文件数据基点 `8 + 第2个值`，按 header 的 offset/size 读取。不解包落盘，不执行其中代码。下面行号为 **ASAR 内虚拟文件**原始换行，offset 为该文件解码后的字符偏移，不能当宿主文件行号：

| 虚拟文件 | 定位 | 证据 |
| --- | --- | --- |
| `.vite/build/main-BPBEjAxi.js` | 行 1687，字符 5038054 | 桌面创建 native pipe 后执行 `process.env[fo]=Pe.pipePath`；fo 在行 26 字符 119491 定义为 CODEX_APP_TOOLS_PIPE_PATH |
| 同上 | 行 39，字符 209853 | `async function Uc` 读取 bundled plugin 的 .mcp.json，构造 bundled AppTools 配置；WSL 分支显式设 env_vars 为 WSL_INTEROP 与 fo |
| 同上 | 行 834，字符 2348056 | 内部 plugin marketplace 更新后调用 `sendAppServerRequest('config/mcpServer/reload', void 0)` |
| `webview/assets/initialize-app-host-services-b944587b60fb.js` | 行 5，字符 245396 | OAuth login 成功路径调用同一重载 RPC |
| `webview/assets/app-initial-438d1df57f70.js` | 行 1834，字符 3491565 | MCP 设置保存通过 config/batchWrite 替换 mcp_servers.<key>；观察到配置写入，不等于已证明已有聊天立即获得新工具 |

以上证明桌面自身有调用重载 RPC 的能力。没有发现可直接保证“用户改 config.toml 后自动完成既有聊天热重载”的证据。也没有验证专门的 UI Reload 按钮。

## 官方文档边界

[MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp)（页面行 1120-1132）说明 stdio 的 env 设置变量，env_vars 允许并转发来自 Codex 本地环境的变量。因此建议最小实验显式配置 `env_vars = ["CODEX_APP_TOOLS_PIPE_PATH"]`，不手工固定 pipe 值。该页面没有为普通 stdio MCP 建立当前聊天 metadata 的保证。

[App-server 文档](https://learn.chatgpt.com/docs/app-server)（页面行 1244-1248）给出 config/mcpServer/reload、mcpServerStatus/list 和 mcpServer/tool/call。前者重读配置并排队刷新加载的聊天；后两者可按 thread 观察实际连接与工具。该契约不等于可从外部连接当前 Windows Desktop 私有端点；新开 app-server 也不能代替刷新现有桌面。

## 关闭缺口的最小真实验证

1. 经授权注册一个只读 probe stdio MCP，仅暴露无参数 `inspect_context`，启动时只记录是否存在 pipe、PID、启动时间；调用时仅记录 params._meta 的键及 thread/turn ID。不要记录全部环境或凭据，也不要让模型提交 ID。
2. 配置显式 env_vars 转发 pipe。通过当前桌面已支持的配置保存/重载入口刷新；若有连接当前桌面 app-server 的合法入口，调用 config/mcpServer/reload。不得用另启执行器证明桌面热重载。
3. 从两条现有主聊天分别真实调用 probe，核对其宿主附加 ID 与两条已知原聊天 ID；连续再调用一次验证逐调用变化。单次手工 RPC 填 _meta 只能验证 parser，不能证明 Codex 自动注入。
4. 观察既有聊天无需重启便出现工具、probe 进程确由当前桌面启动、pipe 当前可 tools/list。读取成功后再核对 host 和已知聊天可读性；不要在本阶段发任何消息。
5. 若没有逐调用可信 thread ID，停止按聊天通知工具实现并修订方案。若无法热重载，记录该限制，待用户当前任务结束后再由用户重启；不能把未验证的热重载写为已完成。

本次只执行读文件、查看环境变量名称和 CLI help/version；没有执行上述 probe、真实重载或任何配置写入。未使用任何相关历史记忆结论。
