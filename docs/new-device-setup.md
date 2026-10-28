# 新设备 Codex 自动安装与运行操作文档

本手册交给**另一台 Windows 设备上、已经登录的 Codex Desktop**执行。目标是在新设备克隆并运行 `https://github.com/xiansheng50/CodexWechatBot`，完成微信绑定、桌面连接及收发验收。它不要求在旧设备再次安装或重新绑定。

当前仓库为私有仓库，需要有读取权限的 GitHub 账号。代码要求 Node.js >=24，已验证基线为 Node.js 24。macOS/Linux 不属于当前已验证、可直接安装的运行环境。

## 自动化范围

给新设备 Codex 提供仓库地址和明确的安装要求后，它可以根据 README 找到本手册，自动完成环境检查、克隆、依赖安装、测试、MCP 配置、桥接启动和状态检查。无需先手工克隆或复制整份文档。仅给一个地址而没有要求安装，不代表已经授权更改设备。

以下动作仍需要用户参与，不应承诺“全程无人值守”：

| 情况 | 用户需要做什么 |
| --- | --- |
| 私有仓库尚无有效授权 | 完成 GitHub 浏览器授权或提供有读取权限的账号登录。 |
| 同一微信从旧设备接管 | 确认旧设备已停止接收，避免两个接收者同时运行。 |
| 首次绑定或重新登录 | 本人微信扫码；服务要求配对码时提供配对码。 |
| 新 MCP 入口尚未加载 | 本轮结束后重启 Codex，并发送续接指令；执行者从已保存进度继续。 |
| 收发验收 | 在手机发送“帮助”“状态”和测试要求，并确认收到回复。 |
| 依赖安装需要提权或替换既有软件 | 完成系统交互，或明确同意替换；不得擅自影响其他项目。 |

已有授权和可用绑定可以复用，不为追求固定流程重复要求用户登录或扫码。本手册是供 Codex 执行的操作指南，不是独立的一键安装器；也不保证不同设备或不同 Codex 版本无条件兼容，实际检查与手机验收通过后才报告可用。

## 1. 复制给新设备 Codex 的指令

下面的指令可直接复制；附上本文件可获得完整检查和故障处理细节。指令不依赖新设备已经克隆仓库。

```text
请在这台 Windows 电脑安装并运行微信与 Codex 桥接项目：
https://github.com/xiansheng50/CodexWechatBot

请实际执行，不只给操作建议。先检查系统、Git、Node.js（推荐已验证的24版本，最低>=24）、npm和私有仓库访问权限。默认安装到当前用户的 Projects\CodexWechatBot；已有合适的仓库可复用，不覆盖本地改动。

允许你克隆仓库、安装缺少的必要依赖、执行 npm ci --ignore-scripts 和 npm test，通过项目 CLI 安装本用户的 MCP 配置、启动桥接并进行微信绑定和收发验收。替换已有全局软件版本、覆盖其他安装或账号时先问我；不提交或推送，不创建 Windows 登录自启动任务，不修改无关配置。

克隆后先读 README.md 和 docs/new-device-setup.md（如果该版本已有此文件），再核对实际 CLI。config.toml 不存在时才创建空文件；已有内容必须保留。检查已有 wechatbot MCP 条目的 Node/仓库绝对路径是否正确，不能把 install-mcp 的 changed:false 当作路径正确。

本次新装、更换 MCP 入口或更新正在运行的项目源码后，不能因工具已可见就假定新版本已生效。先保存不含秘密的进度；若已有本次已确认替换的旧桥接，使用项目 stop 正常停止，再让我在本轮结束后重启 Codex。重启后继续本次安装，使用真正的 wechat_status 检查当前聊天身份；不手写 pipe 或 thread ID、不伪造调用 metadata。

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

需要 GitHub 授权时，优先使用已有 Git Credential Manager 或 GitHub CLI 登录。若采用 GitHub CLI，可执行：

```powershell
gh auth status
gh auth login --hostname github.com --git-protocol https --web
```

仅在现有授权不足时发起浏览器登录；等待用户完成，不索要令牌正文。如果 Git 的旧缓存凭据不可用而 `gh` 已登录，可在此次克隆中使用它，不必改变全局 Git 配置：

```powershell
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' clone https://github.com/xiansheng50/CodexWechatBot.git $setupInstallDir
```

`$setupInstallDir` 必须先按下一节确定。以上是普通 `git clone` 的替代命令，不是要求克隆第二次。GitHub CLI 不是运行桥接的必需依赖。

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
if ($LASTEXITCODE -ne 0) { throw 'Clone failed: check private repository access and network.' }
Set-Location -LiteralPath $setupInstallDir
npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed: resolve the failure before continuing setup.' }
git log -1 --oneline
```

当前基线为 125 项检查，实际以检出版本的报告为准。测试使用临时数据，不代表新设备已经完成微信手机验收。不要复制旧设备的 `node_modules`、运行状态、凭据、游标或聊天编号。

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

先判断本次安装是否需要重新加载：**新装、更换 MCP 的 Node/仓库入口，或更新了正在运行的项目源码，都需要让新版本实际生效，不能只检查工具是否可见。** 旧进程也可能提供同名工具，`start` 也可能复用同一数据目录中仍在运行的旧 daemon。

对于本次已经确认替换、且能核实属于本项目的旧服务，先用 `node src/cli.mjs stop` 正常停止，再安排重载；不要靠进程名强杀。如果路径和源码均未变化、已有安装可用，可以直接调用 `wechat_status` 验证。不能用普通终端运行 `mcp.mjs` 或自己注入 metadata 代替真实工具调用。

需要重新加载新版本，或当前聊天没有工具时：

1. 将安装目录、当前提交、已完成阶段和下一步写入仓库下 `.local/new-device-setup-progress.md`；该目录被 Git 忽略。不要记录令牌、二维码或配对码。
2. 给用户一条明确的续接指令，例如：“本轮结束后重启 Codex，打开这个本地项目/聊天，再发送‘继续新设备安装，读取 .local/new-device-setup-progress.md’。”不要在正在执行的轮次中自行关闭 Codex。
3. 重启后从进度继续，发现并调用真正的 `wechat_status`，确认 caller 对应本次安装聊天。

MCP 加载时会按需启动桥接。有运行故障时可执行 `node src/cli.mjs start`，随后重试一次真实的 `wechat_status`。初次没有保存的可信聊天候选，仍需要这次工具调用，不能只凭进程已启动认定桌面已连接。

如果要使用微信“新建 项目名｜要求”，还需把相应本地目录作为项目在新设备 Codex 中打开，并通过“项目”命令确认它可见；名字、路径和编号以新设备实际列表为准。

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
| 普通消息 | 用户从微信发送普通测试文字，进入新设备的正确聊天并得到回复。 |
| 异常 | 没有本次新增的未知提交、观察缺口或未解决错误；已有记录按实际原因说明。 |

可请用户发送以下测试文字：

```text
请在 commentary 回复 ACK-WX-DEVICE，然后继续当前安装验收，不修改文件。
```

Codex 收到后在 commentary 回复，继续本次验收。最终结果通知要等本轮结束后才生成；结束前将手机是否收到最终通知记为待确认，不提前认定已经送达。接口 `accepted` 也不是手机已读证明。

## 8. 常见阻塞与交付报告

| 情况 | 执行者应做什么 |
| --- | --- |
| 私有仓库无权访问 | 请用户完成浏览器授权或切换到有权限的账号，不索要令牌正文。 |
| `config.toml` 缺失 | 按第 4 节仅创建缺失文件；其他配置保留。 |
| MCP工具不存在 | 保存进度，等用户在本轮结束后重启并续接；不要伪造调用身份。 |
| 服务启动慢 | 等当前一次有界启动流程完成；CLI就绪等待45秒、MCP外层50秒，不并行重复拉起。 |
| 桌面未连接 | 调用真正的 `wechat_status` 注册，再看 `doctor`；不覆盖 pipe/thread ID。 |
| 桌面schema不兼容 | 记录不兼容工具和版本，停止依赖功能验收，不另启模型执行器绕过。 |
| 登录未绑定/失效 | 区分扫码、配对码和首次本人消息各阶段，按第 6 节继续。 |
| 状态未知或命令无回复 | 看安全的状态/日志摘要，先确认是否已执行或已发送，不盲目重发。 |
| owner/业务JSON异常 | 保留原文件，检查实际归属和进程状态；不强杀通用node/codex进程或清空状态。 |

最后报告实际安装目录、Git提交、Node版本、MCP配置文件与入口路径、桌面/微信状态、当前目标与订阅，以及测试和手机确认的证据。未完成步骤明确写“待完成”及原因，不用“安装命令执行成功”替代全部验收。

默认不启用 Windows 登录自启动。用户以后明确需要时，才执行项目的 `autostart enable` 并检查任务结果；该命令遇到已有同名任务会拒绝，不能声称重复执行幂等。移动仓库目录或更换 Node 路径后，也要重新核对 MCP及已启用自启动入口的绝对路径。

源码克隆不迁移原电脑的 Codex 聊天、项目、微信绑定或通知选择。默认运行数据仍位于新设备的 `%LOCALAPPDATA%\WeChatBot`；如果已有 `WECHATBOT_DATA_DIR` 覆盖，先核实用途与实际目录，不能混用两处数据来凑出“已连接”。
