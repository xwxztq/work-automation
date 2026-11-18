# 本机执行模式验证

日期：2026-09-20。以下记录针对本次源码改动，不代表 npm 已发布或后台安装版本已升级。

## Swift / Xcode

通过 `runCodex` 和真实 supervisor 启动确定性的工具链探测程序，选择 `native` 模式，工作目录为 Copet 所在的 taskhub 仓库。探测程序替代模型执行命令，因此这项验证覆盖服务启动路径、环境继承和真实工具链，不覆盖模型决策。

- `swift --version`：退出码 0。
- `xcrun --show-sdk-path`：退出码 0。
- `swift build --package-path macos --scratch-path <临时构建目录>`：退出码 0。
- `swift test --package-path macos --scratch-path <同一临时构建目录> --filter controlsFollowEveryDragEventWithoutTimer`：Swift Testing 实际执行 1 个测试并通过。

没有修改业务源码，没有写入 Linear。定位测试通过不能证明桌宠键盘焦点、中文输入法或任务提交正常；这些仍需原生交互验收。

四个阶段的进程集成测试检查：本机 HOME、TMPDIR、CODEX_HOME、Git 配置和工具链环境保留；外部参考文件可读；不调用 sandbox 启动器；Linear 等无关环境变量不传给子进程；结构化输出和运行模式记录正常；清理不会删除宿主 HOME。旧沙箱的真实权限测试继续通过。

## Computer Use 可行性

下文是最初仅探测 MCP 的记录。后续已完成保留用户配置的 App Server 模型自主原生 UI 操作与真实 Swift 构建测试，详见 [独立能力验证记录](native-computer-use-validation.md)。当前接入方向以该记录为准。

本机 Codex CLI 为 0.153.4，已安装 OpenAI Computer Use 插件 1.0.1001103。插件的 `.mcp.json` 指向 `computer-use-client-launcher mcp`，启动器再调用 `$CODEX_HOME/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`。

只读探测结果：

- 从受限会话中启动客户端：`initialize` 成功，读取工具列表时进程异常退出。
- 从普通本机进程启动客户端：`initialize`、`notifications/initialized`、`tools/list` 成功，返回应用列表、窗口状态、点击、文本输入、按键等工具。

因此，客户端具有可用于后台集成的 MCP 接口；本次没有操作任何应用，没有更改系统授权，也没有证明所有工具调用都可用。官方文档中的桌面产品能力不能直接当成 `codex exec` 的完整支持承诺。

2026-09-20 初测时，WorkAutomation runner 继续使用 `--ignore-user-config` 和 `mcp_servers={}`，不会因选择本机模式自动获得这些工具。用户后续要求保留桌面开发能力，因此不采用仅接入单个 MCP 的限制方案。独立 App Server 实验保留真实用户配置；接入产品还需要处理桌面应用授权、取消、超时和多个任务对桌面的竞争，以及 IAB 等桌面客户端服务。

参考：[OpenAI Computer Use 文档](https://learn.chatgpt.com/docs/computer-use)。

## 2026-09-21 本机插件接入修复

本机 runner 已改为保留用户配置、规则和已启用插件，使用 `--approve-for-me` 处理命令权限请求，并将运行产物目录加入 `--add-dir`。默认沙箱仍使用原有隔离参数。本机模式继续过滤服务凭据与父任务身份，事项操作仍由服务执行结构化意图。

真实 Linear 事项 LIV-1208 已经由修复后的 WorkAutomation 启动并完成 `cua_repl` Chrome 换色、保存和截图；落盘 SVG 的填充值为 `#90cbb5`。详细运行及写回结果见 [Linear 验证记录](workautomation-computer-use-linear-validation.md)。本次没有重新运行 Swift 构建，先前 Swift 记录仅对应当时的执行参数。
