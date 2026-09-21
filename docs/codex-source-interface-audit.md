# Codex 开源接口核对

日期：2026-09-21。只读分析官方源码与本机生成的协议，未修改 Codex 安装、生产 runner 或全局配置。

## 核对版本

- 官方仓库：`https://github.com/openai/codex`。
- 源码提交：`75db67bbc6a18200b52698c8870adaedd7746dea`，2026-09-21。
- 本机 CLI：`0.155.1`；桌面内置 CLI：`0.155.0-alpha.9.2`。
- 使用本机 CLI 的 `app-server generate-ts --experimental` 导出协议到 `/tmp/wauto-codex-protocol-0.155.1`。源码主分支和已安装版本并不完全一致，生产适配应以安装版本生成的协议为准。
- 临时源码目录：`/tmp/wauto-codex-source-review`。

## 已定位的接口和实现

| 用途 | 接口 | 源码位置 |
| --- | --- | --- |
| 创建执行上下文 | `thread/start` | `codex-rs/app-server-protocol/src/protocol/common.rs:559`；`codex-rs/app-server/src/request_processors/thread_processor.rs:1125` |
| 主动开始工作 | `turn/start` | `codex-rs/app-server-protocol/src/protocol/common.rs:1040`；`codex-rs/app-server/src/request_processors/turn_processor.rs:521` |
| 注入宿主提供的工具 | `ThreadStartParams.dynamicTools` | `codex-rs/app-server/src/request_processors/thread_processor.rs:1448` |
| 工具执行回调 | `item/tool/call` | `codex-rs/app-server/src/bespoke_event_handling.rs:1085`；`codex-rs/app-server/src/dynamic_tools.rs:18` |
| 命令、文件和权限审批 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` | 本机生成的 `ServerRequest.ts` |
| MCP 交互请求 | `mcpServer/elicitation/request` | `codex-rs/app-server-protocol/src/protocol/common.rs:1777` |
| 插件选择与 MCP 运行时 | 配置加载、插件选择、MCP 服务目录及权限 | `codex-rs/core/src/session/plugin_selection.rs:10`；`codex-rs/core/src/session/mcp_runtime.rs:304` |

`thread_start_task` 从配置管理器加载有效配置，校验传入的动态工具后交给线程管理器。运行中产生动态工具调用时，App Server 把工具名、参数和 thread/turn/call ID 发给宿主；宿主返回 `contentItems` 和 `success`，App Server 将结果提交给模型继续执行。因此，“宿主自行提供工具”是已有的协议扩展点，不需要伪造桌面客户端身份或修改私有管道。

当前检查的 TypeScript SDK 在 `sdk/typescript/src/exec.ts` 内启动 `codex exec --experimental-json`。它不等价于附着到已运行的桌面客户端。需要双向工具回调和 MCP 交互审批时，App Server 的接口更直接。

## 对 WorkAutomation 的含义

WorkAutomation 可以作为 App Server 的客户端，通过 stdio 启动自己管理的进程，依次完成 `initialize`、`initialized`、`thread/start`、`turn/start`，并处理事件与服务端请求。进程生命周期和协议适配可以内置在 WorkAutomation；用户不需要另配定时任务或手工启动服务。

应保留用户已有配置、插件和 MCP，不沿用清空 MCP 或忽略用户配置的启动方式。已有的本机 Computer Use 与 Swift 构建实验可作为能力证据，但该实验使用的版本为 0.153.4；接口审计阶段的 0.155.1 仅核对了接口定义；后续同日已通过普通 `codex exec` 的 Chrome 导航、换色、保存及截图实测，详见 [Computer Use 验证记录](native-computer-use-validation.md)。这不等于重测全部原生能力或桌面专属工具。

动态工具声明只提供调用协议，不会自动产生工具后端。IAB、桌面任务管理等已知依赖桌面宿主的服务仍需逐项研究接口或由 WorkAutomation 提供合适的后端，不能由“Codex 开源”直接推导完整桌面客户端也已开源或可以直接复用。公开仓库中的 `desktop_app` 目录包含桌面启动辅助代码，不是完整桌面客户端。

本次结论是：主动启动与工具扩展接口已从源码及当前版本协议得到确认；无需先解决桌面 UI 的自动提交，便可推进独立 App Server 与 Computer Use 的产品接入。完整桌面服务等价性仍未验收。

## 官方参考

- [开源组件](https://learn.chatgpt.com/docs/open-source)
- [App Server 协议](https://learn.chatgpt.com/docs/app-server)
- [本次源码提交](https://github.com/openai/codex/tree/75db67bbc6a18200b52698c8870adaedd7746dea)
