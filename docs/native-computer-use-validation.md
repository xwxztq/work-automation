# 本机 Computer Use 与 App Server 独立验证

日期：2026-09-20 至 2026-09-21。范围为独立实验，没有接入生产调度、升级全局安装、重启 WorkAutomation 服务或更新 Linear 任务。

## 判断

本机执行模式可以同时支持真实 Swift 开发和原生 Computer Use。保留用户配置的 App Server 已通过模型自主操作测试；原先清空 MCP、忽略用户配置的 `codex exec` 启动方式不能提供相同能力。

独立 App Server 尚不能被称为 Codex 桌面版的完全替代。内置浏览器存在桌面会话绑定，桌面专属工具也需要客户端提供的服务。正常系统授权和工具确认仍需保留；不应把缺失的客户端服务误判成模型能力不足。

2026-09-21 补充实验验证了另一条路线：由真实 Codex 桌面任务执行工作，同一个任务成功使用原生 Computer Use、内置浏览器、宿主机 Swift 工具链和桌面专属工具。该路线保留桌面宿主提供的工具，不需要独立进程连接其私有管道。已测项目通过不等于所有插件、图像、语音能力逐项验收。

## 实测记录

环境：Codex CLI 0.153.4，用户默认模型 gpt-6-astra，已安装的 unified-computer-use 26.915.31945，macOS 图形登录会话。App Server 通过 stdio JSON-RPC 启动，使用真实用户配置、临时 thread、本机执行权限。没有伪造父任务身份，也没有把父任务的桌面工具管道注入 App Server。

| 能力 | 证据 | 结果范围 |
| --- | --- | --- |
| 原生窗口观察 | 模型通过 `cua.getApp` 读取 AppKit 测试窗口的 AX 树和截图 | 通过 |
| 原生交互 | 模型选择输入框、粘贴 `Model-driven 中文验收`、点击 Record test value | 通过 |
| 结果核对 | AX 与截图显示 `Recorded: Model-driven 中文验收`；宿主机读取 JSON 得到同一值 | 通过，非仅列出工具 |
| 宿主机工具链 | 模型执行 `xcrun swift --version`，返回 Swift 6.3.1，退出码 0 | 通过 |
| 外部仓库访问 | 模型执行 `git -C /Users/san/Projects/Infra/copet rev-parse --show-toplevel`，退出码 0 | 通过，只读 |
| 真实 Swift 构建 | 模型对 taskhub/macos 执行 `swift build`，临时 scratch 目录，12.82 秒结束，退出码 0 | 通过 |
| 真实 Swift 测试 | 模型执行 `swift test --filter controlsFollowEveryDragEventWithoutTimer` | Swift Testing 实际 1 个测试通过；XCTest 另报 0 个 |
| MCP 调用 | 独立 App Server 的 Linear MCP 成功读取 LIV-1201 | 通过，只读 |
| 技能、连接器 | `skills/list` 返回 101 个技能；`app/installed` 返回 9 个连接器；`codex_apps` 有 261 个工具 | 仅清单验证，不能推断每项均可用 |
| 持久 JS | `cua_repl` 多次调用保留 app 绑定并成功操作 | 通过；通用 `node_repl` 仅确认连接 |
| 独立 IAB | 模型创建本机测试页标签返回 `Browser is not available: iab` | 未通过 |
| 桌面 IAB 对照 | 本桌面会话打开同一测试页，输入中文、点击、读取结果、关闭测试标签 | 通过 |
| 独立 Chrome | 初次与一次重试均返回请求策略加载错误 | 未通过 |
| 桌面 Chrome 对照 | 同一机器、桌面会话也返回相同策略加载错误 | 该错误不是本次 native runner 独有 |
| 桌面工具桥接 | 独立 MCP 进程使用现有桌面管道，读取工具清单时返回 `Codex app tools pipe closed` | 未通过，不可作为已支持的接口承诺 |

Swift 编译存在已有的 `SecKeychainGetUserInteractionAllowed`、`SecKeychainSetUserInteractionAllowed` 弃用警告，未导致失败。构建与测试没有改动业务源码。这些结果不能证明 LIV-1201 的桌宠焦点、中文输入法候选框或任务提交缺陷已经修复。

## 中文输入发现

原生 `typeText("WorkAutomation 中文测试")` 的观察结果只有 `WorkAutomation `。随后标准编辑菜单下的 `paste` 成功输入完整中文。测试程序最初没有 Edit 菜单，导致粘贴超时；补齐标准 AppKit 菜单后通过。输入框内容和粘贴能力已测试，中文输入法组词及候选选择没有测试。

## 浏览器和客户端差异

本机安装的 browser-service 实现会按真实 `session_id` 匹配 IAB 后端的 `codexSessionId`。独立会话没有对应的桌面 IAB；桌面会话能够打开同一本机测试页。这支持“需要桌面会话绑定”的判断，但没有证明任意外部客户端可以注册这种绑定。

Chrome 的错误为：

```text
Unable to load browser request-header policy. Retry the browser command.
```

本机插件代码在 Statsig 初始化未成功时返回该错误。普通 HTTPS GET 探测两个相关服务返回 403；这只说明探测请求收到拒绝响应，不能当作真实 SDK 初始化失败的充分根因。未关闭证书校验、跳过请求策略或修改插件实现。

`codex_app` 在独立 App Server 的 MCP 清单中是 disabled。已安装的桌面工具插件还依赖 `CODEX_APP_TOOLS_PIPE_PATH` 和调用线程元数据。单独启动 App Server 不会自动提供侧栏、内置浏览器、桌面任务协调等客户端服务。额外只读桥接实验也未成功，不能通过复制父任务身份来宣称支持。

后续复查使用插件自带的 `launch_codex_app_tools_mcp` 启动器，保留宿主提供的 `CODEX_MCP_NODE_PATH`，仍在读取工具清单时断开。桌面客户端日志在两次实验对应的时间点记录了 `dynamic_app_tools_peer_rejected reason=untrusted-code-signing-identity`。这将桥接失败定位到调用方身份校验；并非仅缺少某个 MCP 配置开关。未修改客户端签名、校验规则或安装文件。需由受支持的桌面执行入口承载，不能把该私有管道当成已开放的集成 API。

具体日志证据为 2026-09-20 的桌面日志，UTC 15:48:01 与 15:55:52。本次文档只保留拒绝原因，不提交用户桌面日志。

## 接入方向

本机执行应保留用户的 Codex 配置、技能、插件和 MCP。不要通过 `--ignore-user-config`、`mcp_servers={}` 或仅注入单个工具来实现用户要求的完整开发能力。

App Server 适合承担模型运行、工具调用、流式结果和交互确认。接入方需要处理审批、MCP elicitation、取消、超时和恢复。原生桌面操作要在同一台已登录的 Mac 上执行，并协调多个任务对键盘焦点的使用。

独立实验客户端新增 `--interactive` 模式，可以把 App Server 请求交给调用者回复，不再因测试窗口之外的审批直接报错。请求原样展示，只有调用者显式提供结果才回复；没有永久授权或默认批准。嵌套审批的协议测试验证了收到拒绝结果后原始工具调用可以正常返回，也验证了退出时未答复请求会被取消。该模式是实验用客户端协议，不代表 WorkAutomation 产品已接入这些交互。

随后在真实 App Server 会话 `01a0bf8a-dfae-7f81-8df8-fef98d0d249f` 中再次触发测试窗口的 MCP 确认，客户端显示请求，显式回复 `decline` 后工具返回未批准结果，未发生等待死锁。实验主动拒绝仅用于验证协议行为，不代表系统阻止了已授权测试。

要保留包含 IAB 和桌面专属工具在内的桌面能力，应由桌面客户端承载执行。2026-09-21 已验证真实桌面任务的这一组合；外部进程直接连接私有桌面管道仍未打通。此次按要求先保留独立实验，WorkAutomation runner 尚未切换到桌面任务执行。

官方接口背景：[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。文档支持客户端审批和工具交互，不等于承诺独立进程继承全部桌面 UI 服务。

## 真实桌面任务验证（2026-09-21）

用户授权后通过 `codex_app.create_thread` 创建任务“本机桌面完整能力验证”，ID 为 `01a0c143-3e0a-7532-b60d-c34d5edca3a8`。该任务使用自己的 Computer Use 和宿主机工具，未复用前一轮独立 App Server 的执行结果。

| 项目 | 结果 |
| --- | --- |
| 原生 AppKit 窗口 | 粘贴 `Desktop-host 中文验收` 并点击 Record；AX、截图和 app 写出的 JSON 值一致 |
| 隐藏 IAB 标签 | 输入 `Desktop-browser 中文验收` 并点击按钮；AX 和截图显示正确结果，标签随后关闭 |
| 宿主机工具链 | Swift 6.3.1；外部 Copet 仓库只读访问成功 |
| 真实 Swift 构建 | taskhub/macos 使用独立 scratch 目录，12.45 秒完成，退出码 0 |
| 真实 Swift 测试 | `controlsFollowEveryDragEventWithoutTimer` 实际执行 1 项并通过，退出码 0；XCTest 另报 0 项 |
| 桌面专属工具 | `codex_app.list_projects` 真实调用成功，只记录返回 65 个项目，不保存项目明细 |

该桌面任务默认仍受 workspace-write 沙箱约束。首次编译和 Swift 构建遇到 `ModuleCache: Operation not permitted`，本机 HTTP 监听遇到 `listen EPERM`；通过正常的 `require_escalated` 宿主机执行后成功。这说明“由桌面承载工具”和“获得本机执行权限”是两个分别需要满足的条件，并非创建桌面任务就自动获得无限权限。

原生测试 app、本任务创建的 IAB 标签和 HTTP fixture 已清理；共享桌面客户端和 Computer Use 服务保持运行。依赖包括已登录的 macOS 图形会话、运行中的桌面客户端、已有系统授权及本机开发工具链。无人值守、GUI 注销后运行、图像生成、音频和其他插件未测试。

完整报告及结构化证据位于 `/Users/san/Documents/Codex/2026-09-21/native-desktop-capability-check/outputs/`，其中 `report.md`、`evidence.json`、`native-window.jpg` 和 `browser-page.jpg` 可用于复核。原始日志不纳入仓库。

## 外部调度、桌面任务执行（2026-09-21）

同一真实桌面任务进一步从 `desktop-job-probe.mjs` 提供的一次性本机 HTTP 调度器领取工作，在自己的隐藏 IAB 标签中输入并点击，再回传可见结果、宿主机命令退出码和报告位置。

- Job ID：`6b45ace5-b64c-414b-b980-1c2eb0cd3c0f`。
- 页面、AX、截图与调度器记录一致：`Desktop queue 中文 6b45ace5`。
- 页面按钮在 UTC `2026-09-21T00:10:39.019Z` 产生交互记录；没有用 shell 调用 `/ui-evidence` 代替 GUI 操作。
- 独立执行 `xcrun swift --version`，退出码 0。
- `POST /result` 被接受，随后 `GET /job` 返回 `completed`，完成时间 UTC `2026-09-21T00:11:21.523Z`；workerTaskId 与真实桌面任务一致。
- 测试报告为上述 outputs 目录下的 `queue-report.md`，截图为 `queue-page.jpg`；父任务也读取调度器状态并核对截图和命令日志。

这证明已启动的桌面任务可以通过普通本机 HTTP 接收外部工作，同时保留自己的桌面工具。调度器不需要调用桌面私有管道，也不会通过清空 MCP 来缩减能力。它本身不能创建或唤醒桌面任务；持续运行、空闲唤醒、租约、重试、取消、审批交互和并发焦点协调尚需生产设计与验证。本次没有证明外部守护进程可独立创建任意桌面任务，也没有接入 WorkAutomation runner。

结果核对后，父任务仅终止本次调度器的已确认进程，进程退出码为 0；状态与证据文件保留。桌面测试任务已正常结束。

## 主动发起约束与入口检查（2026-09-21）

用户要求 WorkAutomation 主动发起桌面执行，不接受要求用户另外维护桌面定时任务。因此，定时拉取不是本项目的接入方案。前述 HTTP 领取实验只证明运行中的桌面任务可以接收工作，不构成主动启动能力验收。

本次只读检查发现：

- 本机 CLI 提供 `codex app-server proxy --sock <path>`，但正在运行的桌面 App Server 使用默认 stdio 传输。进程没有暴露有路径的 Unix 监听 socket；`codex app-server daemon version` 查询默认控制 socket 返回文件不存在。没有启动、重启或重配共享 daemon。
- 安装包中的深链接解析器支持新任务及已有任务的 `prompt` 参数；主进程将它传给 `prefillPrompt`。这只证明可以定位页面和预填输入，没有发现自动提交参数。对先前临时任务执行 `/usr/bin/open` 返回成功，但没有核实预填，也没有提交验收指令，不能视为成功启动运行。
- 普通宿主进程的 `AXIsProcessTrusted()` 返回 true，但没有在只读控件检查中找到预期测试输入。随后 Computer Use 明确返回 `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`。停止此 UI 路线，不用其他 UI 技术绕过拒绝，不将自动点击 Codex 自身列为已可用方案。

拟议的产品边界是 WorkAutomation 内置桌面执行适配器，由它负责连接、提交和状态回传；用户不配置轮询或脚本。但当前安装环境尚未验证可由外部进程调用且保留完整桌面工具的启动接口。适配器应在入口不可用时报告具体原因，不把仅打开页面、保存草稿或启动独立 App Server 当作桌面任务已运行。已运行的桌面会话提供的 `create_thread` 不能被当成外部 Node 进程可直接调用的公共 API。

## 可复现程序和本次证据

实验说明：[experiments/native-capabilities/README.md](../experiments/native-capabilities/README.md)。

本次模型测试 thread：`01a0bf79-3d8b-7020-914c-66b893ded09e`。

- 原生 UI 与宿主机命令 turn：`01a0bf7b-1ef2-7070-8b8f-0aa7157a16ce`。
- 浏览器 turn：`01a0bf7c-906e-7a21-b072-78a5d1a1ef8e`。
- Swift 构建与测试 turn：`01a0bf7f-b35f-74a3-98f7-09e92aebc9f8`。

运行证据位于 `/tmp/wauto-native-capabilities/`，包括 App Server 的结果、通知、截图和测试 JSON。临时目录可能被系统清理，文档保留结果摘要。原始通知可能包含账号清单和截图，不应直接提交到仓库或发布。


## 2026-09-21 普通 codex exec 的 Chrome 实测

用户要求通过普通 `exec` 打开 Chrome，制作 Codex 图标头部的卡通小人。本次使用 `/Users/san/.bun/bin/codex` 0.155.1，运行 `codex exec --approve-for-me --skip-git-repo-check --json -C <作品目录> -o <最终回复文件> -`。保留本机配置和已安装插件，没有使用 `--ignore-user-config`，没有将本次执行改成 App Server 客户端实验。

启动前仅移除父任务继承的 `CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_APP_TOOLS_PIPE_PATH`、`CODEX_PERMISSION_PROFILE`、`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`。独立执行任务 ID 为 `01a0c1e7-9c98-7942-bcfd-49d32ab62452`。

实际调用 `cua_repl.js`：`cua.createBrowserTab("chrome", ...)` 成功建立 Chrome 标签；`tab.goto` 打开本地 SVG 绘图页面；`tab.getAXState` 观察控件；`tab.click(15)` 将背带裤由薰衣草紫切换成薄荷绿；重新观察后 `tab.click(16)` 保存作品。状态、前后截图及本地保存文件相互吻合。作品以代码生成 SVG，Computer Use 负责真实浏览器导航、点击、观察和保存；这不是纯鼠标手绘测试。

运行的是桌面端安装的 `unified-computer-use` 26.915.31945，入口为 `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs`。本次 Chrome 后端由 `cua.listBrowsers` 报告为 `type: extension`。该证据支持“同一套 Computer Use 插件和运行时、独立执行会话”，不能据此声称所有桌面专属服务都可由 exec 使用，也不能将浏览器扩展操作误称为本次已验证原生应用控制。

此前 Chrome 的 request-header policy 错误本次未复现；原因未追溯，未修改策略或插件实现。未重测 IAB。没有修改 WorkAutomation 产品接入或部署。

作品和原始调用记录：`/Users/san/.codex/visualizations/2026/09/20/01a0bf59-6300-71d0-a482-b42e3c8c7557/exec-chrome-codex/`。重点文件为 `events.jsonl`、`invocation.json`、`runtime-processes.json`、`before.jpg`、`after.jpg`、`codex-buddy.svg`、`ui-save.json`。
