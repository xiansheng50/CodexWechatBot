# 新设备 Codex 自动安装与运行操作文档

本手册交给**另一台 Windows 设备上、已经登录的 Codex Desktop**执行。目标是在新设备克隆并运行 `https://github.com/xiansheng50/CodexWechatBot`，完成微信绑定、桌面连接及收发验收。它不要求在旧设备再次安装或重新绑定。

当前仓库为公开仓库，普通 HTTPS 克隆无需 GitHub 登录或仓库授权。代码要求 Node.js >=24，已验证基线为 Node.js 24。macOS/Linux 不属于当前已验证、可直接安装的运行环境。

## 自动化范围

给新设备 Codex 提供仓库地址和明确的安装要求后，它可以根据 README 找到本手册，自动完成环境检查、克隆、依赖安装、测试、MCP 配置、桥接启动和状态检查。无需先手工克隆或复制整份文档。仅给一个地址而没有要求安装，不代表已经授权更改设备。

以下动作仍需要用户参与，不应承诺“全程无人值守”：

| 情况 | 用户需要做什么 |
| --- | --- |
| 同一微信从旧设备接管 | 确认旧设备已停止接收，避免两个接收者同时运行。 |
| 首次绑定或重新登录 | 本人微信扫码；服务要求配对码时提供配对码。 |
| 新 MCP 入口尚未加载 | 若当前环境无法重新加载 MCP，本轮结束后重启 Codex并发送续接指令；执行者从已保存进度继续。 |
| 收发验收 | 在手机发送“帮助”“状态”和测试要求，并确认收到回复。 |
| 依赖安装需要提权或替换既有软件 | 完成系统交互，或明确同意替换；不得擅自影响其他项目。 |

已有授权和可用绑定可以复用，不为追求固定流程重复要求用户登录或扫码。本手册是供 Codex 执行的操作指南，不是独立的一键安装器；也不保证不同设备或不同 Codex 版本无条件兼容，实际检查与手机验收通过后才报告可用。

## 1. 复制给新设备 Codex 的指令

下面的指令可直接复制；附上本文件可获得完整检查和故障处理细节。指令不依赖新设备已经克隆仓库。

```text
请在这台 Windows 电脑安装并运行微信与 Codex 桥接项目：
https://github.com/xiansheng50/CodexWechatBot

请实际执行，不只给操作建议。先检查系统、Git、Node.js（推荐已验证的24版本，最低>=24）、npm和公开仓库的网络可达性，不把 GitHub 登录作为安装前置。默认安装到当前用户的 Projects\CodexWechatBot；已有合适的仓库可复用，不覆盖本地改动。

允许你克隆仓库、安装缺少的必要依赖、执行 npm ci --ignore-scripts 和 npm test，通过项目 CLI 安装本用户的 MCP 配置、启动桥接并进行微信绑定和收发验收。替换已有全局软件版本、覆盖其他安装或账号时先问我；不提交或推送，不创建 Windows 登录自启动任务，不修改无关配置。

克隆后先读 README.md 和 docs/new-device-setup.md（如果该版本已有此文件），再核对实际 CLI。config.toml 不存在时才创建空文件；已有内容必须保留。检查已有 wechatbot MCP 条目的 Node/仓库绝对路径是否正确，不能把 install-mcp 的 changed:false 当作路径正确。

先按第 5 节区分生效范围：新装或更换 MCP 入口、更新 MCP 工具代码或说明时，需要重新加载 MCP；无法重新加载时，保存进度并让我在本轮结束后重启 Codex。仅更新桥接业务代码时，正常 stop/start 桥接即可，不要求重启 Codex；已有安装升级按第 9 节操作。不能因工具可见或 start 返回成功就认定新代码已加载。使用真正的 wechat_status 检查当前聊天身份，不手写 pipe 或 thread ID、不伪造调用 metadata。

确需 GitHub 浏览器授权、停止旧设备接收、微信扫码、配对码或重启 Codex 时，逐项给我明确操作；其他已授权步骤自动继续。账号凭据和二维码只在本机使用，不写入仓库、不上传。不要强杀其他服务、删除未知 owner 锁或复制旧机凭据。

使用同一微信接管前提醒我停止旧机桥接。用 login --qr-only 获取本地二维码，展示给我扫码，随后读取 login-status；需要配对码时用 login-verify 的交互输入提交。confirmed 后让我在手机 ClawBot 发送“帮助”，再检查微信已连接。

我授权把新设备的当前安装聊天设为微信普通消息目标，并开启该聊天的持续微信完成通知。若我另行指定了目标聊天，使用我指定的目标。核对当前聊天身份、实际选择和订阅，然后让我从微信发送“状态”和一条普通测试要求，验证进入正确聊天。最后汇报仓库版本、安装目录、MCP路径、连接状态、实际已验证结果和仍需我操作的事项；不要把扫码成功或接口接受等同于手机已收到。
```

这段授权不包含替换其他账号、强制覆盖目录、改动其他 MCP 条目、提交推送代码或启用 Windows 登录自启动。遇到这些情况，只询问真正缺失的决定，不重复请求已经授权的常规安装操作。

## 2. 检查环境和已有安装

执行者是新设备的 Codex；可自动完成下列检查：

- 确认是 Windows，当前 Codex Desktop 已登录且能够使用一个本地主聊天。不要把 WSL/Linux shell 当作本项目的 Windows 安装环境。
- 检查 `git --version`、`node --version`、`npm --version`。已有 Node >=24 时先验证，不为安装本项目擅自卸载或替换其他项目使用的全局版本。
- 缺少必要依赖时，使用官方来源或机器已有的受信任包管理器，先核实实际包和版本再安装。不要假定“最新 LTS”始终就是 Node.js 24；需要管理员交互或替换现有版本时交给用户确认。
- 检查建议安装目录。已有目录时，先查 `git remote -v`、当前分支和 `git status --short`；只有确认是同一仓库、工作树干净且位于 `main` 时，才可 `git pull --ff-only` 更新。目录有其他文件、本地改动或分叉时，保留原状并选择其他空目录或询问用户。禁止 `reset --hard`、`clean` 或强推。
- 新设备已有 WeChatBot 数据或微信绑定时，不覆盖配置、凭据和状态。先确认是继续既有安装还是换账号，不能仅为了重新安装就再次扫码。
- 启动检查会调用系统自带的 `powershell.exe`，通过 `Get-CimInstance Win32_Process` 查询进程创建时间。查询不可用时会拒绝启动；按第 8 节排查，不通过删锁或关闭校验绕过。

普通公开仓库克隆不需要 GitHub CLI 或浏览器登录。克隆失败时先检查网络、代理、仓库地址及 Git 错误；若实际错误涉及机器已有的凭据或组织访问限制，再按具体原因处理，不要求用户提供令牌正文。GitHub CLI 不是运行桥接的必需依赖。

## 3. 克隆并验证可运行源码

以下示例用于目标目录尚不存在的情况；用户已提供目录时采用用户目录，不固定到旧机的盘符或用户名。每条原生命令都必须检查退出码，失败时停止本阶段并处理原因，不能直接继续安装。

```powershell
$setupRepoUrl = 'https://github.com/xiansheng50/CodexWechatBot.git'
$setupInstallDir = Join-Path $env:USERPROFILE 'Projects\CodexWechatBot'
if (Test-Path -LiteralPath $setupInstallDir) {
    throw 'Target directory exists: inspect it before proceeding; do not overwrite.'
}
New-Item -ItemType Directory -Path (Split-Path -Parent $setupInstallDir) -Force | Out-Null
git clone $setupRepoUrl $setupInstallDir
if ($LASTEXITCODE -ne 0) { throw 'Clone failed: check repository URL, network and Git diagnostics.' }
Set-Location -LiteralPath $setupInstallDir
npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed: resolve the failure before continuing setup.' }
git log -1 --oneline
if ($LASTEXITCODE -ne 0) { throw 'Cannot record the installed revision.' }
```

测试数量随版本变化，以本次检出版本的实际报告和退出码为准，不以固定数量作为安装条件。测试使用临时数据，不代表新设备已经完成微信手机验收。不要复制旧设备的 `node_modules`、运行状态、凭据、游标或聊天编号。

## 4. 准备并安装 MCP

当前 CLI 安装器要求 Codex 的 `config.toml` 已存在。仅在缺失时创建空文件，尊重 `CODEX_HOME`，不覆写已有文件：

```powershell
$setupConfigRoot = if ($env:CODEX_HOME) {
    $env:CODEX_HOME
} else {
    Join-Path $env:USERPROFILE '.codex'
}
New-Item -ItemType Directory -Path $setupConfigRoot -Force | Out-Null
$setupConfigFile = Join-Path $setupConfigRoot 'config.toml'
if (-not (Test-Path -LiteralPath $setupConfigFile)) {
    New-Item -ItemType File -Path $setupConfigFile | Out-Null
}
node src/cli.mjs install-mcp
if ($LASTEXITCODE -ne 0) { throw 'MCP installation failed: preserve the config and inspect the error.' }
```

安装器备份原文件，只维护 `# BEGIN wechatbot managed` / `# END wechatbot managed` 之间的块。检查该块的 `command` 指向新设备实际 Node 可执行文件，`args` 指向本次安装的 `src/mcp.mjs`；不要将整份配置或其他条目的秘密输出到聊天。

**已有受管块时，重复 `install-mcp` 不会自动更新路径。** 如果块内仍指向其他目录或旧 Node，先确认哪个安装应该保留。确认替换本项目旧入口后，才通过 `uninstall-mcp`、`install-mcp` 重装该块并再次核对路径；不要手工重写整份 `config.toml`。未受管同名条目、损坏块或并发修改要按 CLI 提示处理，不强行覆盖。

## 5. 让 Codex 加载工具并注册当前聊天

按实际变动选择需要重启的进程，不能只检查工具是否可见：

| 变动 | 生效操作 |
| --- | --- |
| 首次安装，或更换 MCP 的 Node/仓库入口 | 核对配置路径并重新加载 MCP；无法重新加载时，保存进度后由用户重启 Codex。 |
| 修改 `src/mcp.mjs` 或它加载的工具代码、工具说明 | 重新加载 MCP，刷新运行代码与工具说明；涉及桥接业务改动时还要重启桥接。 |
| 仅修改桥接业务代码，例如 `a746853` 的全局通知模式 | 正常 `stop` 后 `start` 桥接即可，无需重启 Codex；具体升级步骤见第 9 节。 |
| 仅修改文档，或在微信切换通知模式/开关 | 无需重启。模式、开关按各自命令规则生效。 |

`start` 会复用同一数据目录中仍在运行的 daemon，不能代替重启。对于本次已确认替换、且能核实属于本项目的旧服务，使用项目 `stop` 正常停止，不靠进程名强杀。路径和源码均未变化、已有安装可用时，直接调用 `wechat_status` 验证。不能用普通终端运行 `mcp.mjs` 或自己注入 metadata 代替真实工具调用。

需要重新加载 MCP 或当前聊天没有工具时，使用当前环境实际提供的重新加载方式；若没有可用方式，则：

1. 将安装目录、当前提交、已完成阶段和下一步写入仓库下 `.local/new-device-setup-progress.md`；该目录被 Git 忽略。不要记录令牌、二维码或配对码。
2. 给用户一条明确的续接指令，例如：“本轮结束后重启 Codex，打开这个本地项目/聊天，再发送‘继续新设备安装，读取 .local/new-device-setup-progress.md’。”不要在正在执行的轮次中自行关闭 Codex。
3. 重启后从进度继续，发现并调用真正的 `wechat_status`，确认 caller 对应本次安装聊天。

MCP 加载时会按需启动桥接。有运行故障时可执行 `node src/cli.mjs start`，随后重试一次真实的 `wechat_status`。初次没有保存的可信聊天候选，仍需要这次工具调用，不能只凭进程已启动认定桌面已连接。

微信“新建｜要求”不需要选择项目，也不继承当前项目；“新建 项目名｜要求”则需要先把相应本地目录作为项目在新设备 Codex 中打开，并通过“项目”命令确认可见。两种创建类型按当前桌面能力分别校验，不支持时只拒绝该类型新建，不据此判定已有聊天续聊不可用；名字、路径和编号以新设备实际列表为准。

## 6. 扫码绑定本人微信

使用同一 ClawBot 账号切换设备前，让用户在旧设备项目目录执行 `node src/cli.mjs stop`，确认不会再由旧机自动拉起同时接收。当前没有跨设备收信协调机制；不要从新机假设旧机已停止，也不要自动复制旧机凭据。

先读取 `node src/cli.mjs status`。已有可用绑定则保留并验证；需要登录时才执行：

```powershell
node src/cli.mjs login --qr-only
if ($LASTEXITCODE -ne 0) { throw 'QR code request failed.' }
node src/cli.mjs login-status
```

Codex 将 CLI 返回的本地 `qrPath` 图片展示给用户，请用户用本人微信扫码。不要上传二维码、打印凭据或将它们提交到 Git。

执行者分次读取 `login-status`，每次等待保持短且可中断；不连续数分钟阻塞工具。登录会话约 5 分钟有效，过期或错误时说明原因再发起新会话。已有登录未结束时先看状态，不反复执行 `login`。

遇到 `need_verifycode` 时，让用户提供微信显示的配对码，再运行 `node src/cli.mjs login-verify`，通过交互终端的标准输入提交。这个命令不接受命令行验证码参数；不要把验证码放进 shell 命令、环境变量或仓库文件。

`login-status=confirmed` 只表示扫码凭据已保存。此时请用户在手机 ClawBot 发送“帮助”，收到本人消息及回复上下文后，`weixin` 才会变成 `connected`。

## 7. 设置聊天并完成收发验收

用户采用第 1 节指令时，已明确授权选择新设备当前安装聊天、开启该聊天的持续完成通知。使用真实工具依次执行：

1. `wechat_status`：确认当前调用聊天身份和编号。
2. `wechat_select_current_chat`：选择该聊天。
3. `wechat_set_notifications`，参数 `enabled=true`：开启该聊天通知。
4. 再调用 `wechat_status`，以及终端 `node src/cli.mjs doctor`，核对实际结果。

如果用户没有采用上述授权、另有目标或只是测试安装，先明确目标，不擅自改变选择。明确选择成功会按默认规则开启目标聊天的持续通知并关闭原目标的持续通知；用户可随后单独关闭。不要从其他聊天的通知推断普通消息目标。

完成条件：

| 检查 | 必须确认的结果 |
| --- | --- |
| 安装与测试 | 安装目录、提交已记录；依赖安装和该版本测试成功。 |
| MCP入口 | Node/脚本路径正确，当前聊天实际能调用三个工具。 |
| 桌面 | `desktop=connected`、`desktopCheck.compatible=true`；当前聊天身份正确。 |
| 微信 | `weixin=connected`；用户确认手机收到“帮助”和新发送的“状态”回复。 |
| 路由 | selected 为用户授权的聊天，subscriptions 包含用户要求开启的聊天。 |
| 通知模式 | 微信“状态”显示实际全局模式；新安装默认结果模式，已有配置保留，不为安装擅自覆盖。 |
| 普通消息 | 用户从微信发送普通测试文字，进入新设备的正确聊天；结束时按当前模式收到结果或简短通知。 |
| 异常 | 没有本次新增的未知提交、观察缺口或未解决错误；已有记录按实际原因说明。 |

可请用户发送以下测试文字：

```text
请在 commentary 回复 ACK-WX-DEVICE，然后继续当前安装验收，不修改文件。
```

Codex 收到后在 commentary 回复，继续本次验收。最终结果通知要等本轮结束后才生成；结束前将手机是否收到最终通知记为待确认，不提前认定已经送达。接口 `accepted` 也不是手机已读证明。

### 两种通知模式的验收

基础收发通过后，在用户授权的测试聊天中按下面顺序验收。两种模式是所有聊天共用的设置，先记录原模式、selected 和 subscriptions；模式切换命令不应更改目标或任何订阅。若当前安装轮次尚未结束，先完成本轮，后续再逐轮验收；不能在同一未结束轮次中把两次要求当作两个已完成结果。

1. 微信发送 `模式 结果`，收到切换确认后发送 `状态`，确认“通知模式：结果模式”。用单次编号命令 `#编号 请只在最终回复中输出 ACK-WX-RESULT，不调用工具、不修改文件。` 发往已授权测试聊天（编号以实际列表为准，不切换目标）等待真实轮次结束，确认手机收到带 `ACK-WX-RESULT` 正文的结果通知。
2. 微信发送 `模式 仅通知`，收到切换确认后发送 `状态`，确认“通知模式：仅通知模式”。待上一轮结束后，用 `#编号 请只在最终回复中输出 ACK-WX-BRIEF，不调用工具、不修改文件。` 发往同一测试聊天，另起一轮等待本轮结束，确认手机通知只显示聊天编号、标题、“本轮已结束”和回 Codex 查看结果的提示，不含 `ACK-WX-BRIEF` 正文；在 Codex 中确认该正文确实已产生。
3. 核对 selected 和 subscriptions 与切换模式前一致；在已授权的范围内正常 stop/start 桥接后，再发送 `状态`，确认模式仍保留、既有订阅没有重置。切换模式本身无需重启。
4. 按用户原设置恢复模式；若用户明确要求保留新模式，保留其选择。若为验收临时调整过某个聊天的订阅，按事先记录恢复，不改动其他聊天。

只验收用户授权的订阅：关闭某个测试聊天的通知后，微信直接发起的要求仍应按当前模式收到结束回复；该聊天之后由桌面单独发起的轮次不再产生纯订阅通知。可用此区别核对“通知开关”与“通知内容模式”没有混淆，不为测试擅自新增其他订阅。失败和中断仍应分别显示“执行失败”“已中断”，不统一称为任务成功；无需为安装验收故意制造失败。

两种模式只作用于之后生成的结束通知；切换前已生成的待发送通知、手动重试通知保留原正文。帮助、状态、转入/创建确认、异常提示仍正常返回。微信要求与订阅命中同一轮时只产生一份结束通知，新建聊天首轮同样遵循全局模式。

记录每轮实际结果和手机确认。若没有等到轮次结束或用户尚未确认收到，标记为“待验收”；不要把自动化测试、状态 connected 或微信接口 accepted 写成手机实收。具体历史证据见[验收记录](acceptance.md)，不覆盖旧记录。

## 8. 常见阻塞与交付报告

| 情况 | 执行者应做什么 |
| --- | --- |
| 仓库克隆失败 | 公开仓库无需预先登录；检查 URL、网络、代理及实际 Git 错误，不把所有失败归为缺授权。 |
| `config.toml` 缺失 | 按第 4 节仅创建缺失文件；其他配置保留。 |
| MCP工具不存在 | 保存进度，等用户在本轮结束后重启并续接；不要伪造调用身份。 |
| 服务启动慢 | 等当前一次有界启动流程完成；CLI就绪等待45秒、MCP外层50秒，不并行重复拉起。 |
| 桌面未连接 | 调用真正的 `wechat_status` 注册，再看 `doctor`；不覆盖 pipe/thread ID。 |
| 桌面schema不兼容 | 记录不兼容工具和版本，停止依赖功能验收，不另启模型执行器绕过。 |
| 登录未绑定/失效 | 区分扫码、配对码和首次本人消息各阶段，按第 6 节继续。 |
| 状态未知或命令无回复 | 看安全的状态/日志摘要，先确认是否已执行或已发送，不盲目重发。 |
| 无法查询进程创建时间 | 检查 `powershell.exe`、CIM/Win32_Process 查询及机器策略；保留旧锁和状态，不强杀其他进程或绕过校验。 |
| owner/业务JSON异常 | 保留原文件，检查实际归属和进程状态；不强杀通用node/codex进程或清空状态。 |

最后报告实际安装目录、Git提交、Node版本、MCP配置文件与入口路径、桌面/微信状态、当前目标、订阅和全局通知模式，以及测试和手机确认的证据。未完成步骤明确写“待完成”及原因，不用“安装命令执行成功”替代全部验收。

默认不启用 Windows 登录自启动。用户以后明确需要时，才执行项目的 `autostart enable` 并检查任务结果；该命令遇到已有同名任务会拒绝，不能声称重复执行幂等。移动仓库目录或更换 Node 路径后，也要重新核对 MCP及已启用自启动入口的绝对路径。

源码克隆不迁移原电脑的 Codex 聊天、项目、微信绑定或通知选择。默认运行数据仍位于新设备的 `%LOCALAPPDATA%\WeChatBot`；如果已有 `WECHATBOT_DATA_DIR` 覆盖，先核实用途与实际目录，不能混用两处数据来凑出“已连接”。

## 9. 已有安装升级

在原安装目录升级，不重新克隆覆盖，不复制其他设备的运行数据。正常升级保留原数据目录、绑定有效的微信账号、聊天编号、当前目标、订阅和通知模式；旧配置没有模式字段时默认结果模式，无需迁移数据或重新扫码。若账号确已失效，另按登录流程处理。

先确认这是目标仓库、当前为 `main` 且工作树干净，并记录旧提交。记录本机实际数据目录（包括 `WECHATBOT_DATA_DIR` 覆盖）、MCP 的 Node/脚本路径；服务可用时记录 status 的 selected、subscriptions、notificationMode 及已有异常。不要把凭据、二维码、token 或原始运行文件放进提交/报告。

选择微信收发空闲时正常停止本项目桥接；停机期间微信命令和通知不能即时处理。下面命令在已核实的原安装目录执行，每一步失败立即停下处理，禁止强推、强制覆盖或删锁继续：

```powershell
$upgradeBranch = git branch --show-current
if ($LASTEXITCODE -ne 0 -or $upgradeBranch -ne 'main') { throw 'Inspect the current branch before upgrading.' }
$upgradeChanges = git status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the working tree.' }
if ($upgradeChanges) { throw 'Preserve local changes before upgrading; do not overwrite.' }
git log -1 --oneline
if ($LASTEXITCODE -ne 0) { throw 'Cannot record the previous revision.' }
node src/cli.mjs stop
if ($LASTEXITCODE -ne 0) { throw 'Stop failed: verify the service owner before continuing.' }
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Update failed: preserve the checkout and inspect the branch or network.' }
npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed: keep the service stopped and resolve the failure.' }
node src/cli.mjs start
if ($LASTEXITCODE -ne 0) { throw 'Start failed: inspect this installation startup log.' }
node src/cli.mjs status
if ($LASTEXITCODE -ne 0) { throw 'Status failed: do not report the upgrade as complete.' }
node src/cli.mjs doctor
if ($LASTEXITCODE -ne 0) { throw 'Doctor failed: inspect the diagnostics.' }
git log -1 --oneline
if ($LASTEXITCODE -ne 0) { throw 'Cannot record the updated revision.' }
```

这些是升级操作示例，不是要求在每次阅读文档时停止正式服务。仅文档变更无需重启或重新安装依赖；程序升级时以上完整流程也会验证检出版本与依赖。

按第 5 节判断是否还要重新加载 MCP。Node 和仓库路径未变时无需重复 `install-mcp`；路径变了才按第 4 节核对并修复受管块。只启动新版桥接不会刷新已有 MCP 进程的代码或工具说明；例如 `d3ee949` 改过选择工具说明，而随后 `a746853` 的模式功能只改桥接业务代码。若当前环境没有可用的 MCP 重载方式，保存进度后在本轮结束时由用户重启 Codex，再继续检查。

最后调用真正的 `wechat_status`，确认当前调用身份正确；核对 `desktop=connected`、绑定有效时 `weixin=connected`、`doctor` 的 `desktopCheck.compatible=true`，以及 selected、subscriptions、notificationMode 与预期一致。不能仅凭 CLI 退出码、PID 存在、`alreadyRunning` 或仍为 `0.1.0` 的版本号认定新版生效；`doctor.codeVersion` 也不是本仓库 Git 提交。结合已记录的新提交、完成的进程重启，以及微信“帮助”“状态”对新命令/模式的展示确认。

本轮升级不要主动重新选择聊天来“恢复连接”，以免触发新的订阅切换。新版只是启动时不会重置原选择或订阅；之后用户明确选择/切换或新建聊天，才会开启新目标通知并关闭原目标通知，其他独立订阅保留。模式是全局设置，不改变这条规则。按第 7 节完成收发及两种模式的实际验收；尚未完成的手机步骤如实标记待确认。
