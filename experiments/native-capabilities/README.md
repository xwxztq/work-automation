# 本机能力独立实验

这些程序不接入 WorkAutomation 调度，不安装全局包，不修改常驻服务。实验需要在已登录的 macOS 图形会话内运行；本机 Codex 登录、插件及系统授权仍由用户已有配置提供。

## 启动测试窗口

在仓库根目录运行：

```sh
node experiments/native-capabilities/prepare-fixture.mjs /tmp/wauto-native-capabilities
WAUTO_PROBE_OUTPUT=/tmp/wauto-native-capabilities/recorded-value.json /tmp/wauto-native-capabilities/NativeCapabilityProbe.app/Contents/MacOS/NativeCapabilityProbe
```

该命令会保持运行，关闭测试窗口即可退出。窗口通过标准 AppKit 编辑菜单支持粘贴；点击 Record test value 才会写入指定的测试 JSON 文件。不要覆盖正在运行的同名测试程序，重编译前先退出旧进程。

## App Server 测试会话

另开终端：

```sh
node experiments/native-capabilities/app-server-session.mjs /tmp/wauto-native-capabilities/app-server-session
```

默认调用 PATH 中的 `codex`，也可用 `WAUTO_CODEX_BIN` 指定可执行文件。会话使用真实用户配置、临时 thread 和本机执行权限，不移除 MCP 或技能。不会把父任务 ID 或桌面工具管道冒充为独立会话的身份。登录和插件依赖可能访问其正常服务；这不是完全离线测试。

每行输入一个 JSON-RPC 请求包装。`params.threadId` 的 `$thread` 会替换为该测试会话的真实 ID。例如，让模型操作测试窗口并核对宿主机文件：

```json
{"method":"turn/start","params":{"threadId":"$thread","input":[{"type":"text","text":"Use Computer Use only on com.workautomation.NativeCapabilityProbe. Inspect the UI, paste Model-driven 中文验收 into the input, click Record test value, verify the visible result, then read /tmp/wauto-native-capabilities/recorded-value.json through host shell. Do not modify other apps, settings or services."}]}}
```

通过 `command/exec` 单独测试工具链：

```json
{"method":"command/exec","params":{"command":["/usr/bin/xcrun","swift","--version"],"cwd":"/tmp","sandboxPolicy":{"type":"dangerFullAccess"},"timeoutMs":30000}}
```

退出：

```json
{"method":"close"}
```

实验客户端只响应本次授权范围内、目标 bundle ID 精确匹配的测试窗口确认，不保存永久授权。其他确认会报错；这只是实验客户端的行为，不能原样作为产品审批处理。产品需要向用户展示、等待并回复 App Server 的确认请求。不要把测试用的自动确认规则扩大到所有应用。

添加 `--interactive` 可以处理测试窗口以外的正常交互，不启用上述测试自动批准。客户端打印完整的 `SERVER_REQUEST` 后，调用者可以使用对应请求 ID 和协议要求的结果回复，例如明确拒绝某个 MCP 请求：

```json
{"method":"respond","id":12,"result":{"action":"decline","content":null}}
```

不同请求的响应格式不同，应遵循 App Server 协议，不能对所有请求都发送 `action`。普通命令按输入顺序处理，回复请求可在原命令等待期间处理。未答复不会自动批准，退出会取消等待。

`results.jsonl`、`notifications.jsonl` 和截图保存在输出目录。浏览器 MCP 调用需要真实 turn 元数据，优先由模型在 `turn/start` 中调用；直接 `mcpServer/tool/call` 不等价于完整模型工具调用。

## 其他探测

- `app-server-probe.mjs <output>`：插件、技能、连接器和 MCP 清单；清单不代表调用全部成功。
- `mcp-probe.mjs <output> [app-id] [--allow-fixture]`：旧 Computer Use MCP 的直接探测，仅兼容已安装的 macOS 客户端。
- `browser-fixture.mjs`：临时本机网页，打印随机监听端口；停止进程即关闭服务。
- `desktop-bridge-probe.mjs <installed-server.mjs> <real-independent-thread-id> <output>`：通过插件自带启动器只读探测桌面工具桥接。依赖桌面宿主提供的管道，不能作为已支持的独立接入方式。2026-09-20 实测在读取工具清单时返回 `Codex app tools pipe closed`；桌面日志的原因为 `untrusted-code-signing-identity`。

实测结果及限制见 [独立能力验证记录](../../docs/native-computer-use-validation.md)。

## 桌面任务领取外部工作

`desktop-job-probe.mjs` 是独立的一次性本机调度器，用于验证真正由桌面客户端承载的任务能否领取外部工作、保留 IAB 与原生工具、回传结果。它不通过桌面内部管道创建任务，不修改 WorkAutomation。

```sh
node experiments/native-capabilities/desktop-job-probe.mjs /tmp/wauto-desktop-dispatch-test
```

输出目录必须为本次测试单独使用，不能与仍在运行的测试共用。程序只监听 `127.0.0.1`，将随机端口、单次 token 和 jobId 写入权限为 600 的 `manifest.json`，控制台不打印 token。启动真实桌面测试任务需要用户授权；运行调度器本身不会创建或唤醒桌面任务。

桌面任务用文件里的 token 访问控制接口：

- `POST /claim`：领取任务，JSON 包含真实的 `workerTaskId`。返回测试页面路径和本次随机测试值。
- 打开 `/fixture`：在 IAB 中输入测试值、点击按钮；页面记录对应的 UI 事件。不得通过 shell 直接写入 UI 事件来代替交互。
- `POST /result`：提交 jobId、workerTaskId、实际看到的 observedValue、hostCommandExitCode 和 reportPath。只有对应任务已领取、页面事件存在且测试值匹配时才接受。
- `GET /job`：查询本次任务状态，检查最终是否 completed。

只有测试页面和其 UI 事件接口不需要控制 token，控制接口必须携带 Bearer token。该程序仅用于本机可信测试，未实现生产所需的租约、任务重试、取消、完整结果协议、审批展示及长期存储。`completed` 只表示本次测试流程完成，不表示 WorkAutomation 已部署或所有桌面能力已验收。
