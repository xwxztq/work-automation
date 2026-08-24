# Agent 结构化结果协议 v1

这份协议定义 Work Automation 四个处理阶段与 Codex Agent 之间的结果边界，以及服务内部统一的事项平台接口。调度器会把运行绑定和事项快照交给 Agent，校验并保存最终结果，再受控执行已注册的事项平台操作。

## 结果封装

Agent 最终输出必须是单个 JSON 文档，不能带 Markdown 代码块或说明文字。四个阶段统一使用 schemaVersion 为字符串 "1"：

    {
      "schemaVersion": "1",
      "run": {
        "stage": "part2",
        "projectKey": "work-automation",
        "parentIssueId": "issue-parent",
        "allowedOperations": ["comment.create", "issue.state.update"]
      },
      "target": {
        "platform": "primary-issues",
        "issueId": "issue-1171"
      },
      "operations": [
        {
          "type": "comment.create",
          "idempotencyKey": "issue-1171:part2:complete-comment",
          "payload": {
            "body": "实现完成，测试通过。"
          }
        },
        {
          "type": "issue.state.update",
          "idempotencyKey": "issue-1171:part2:testing-state",
          "payload": {
            "state": "Testing"
          }
        }
      ]
    }

字段含义：

- **schemaVersion**：当前只接受字符串 "1"。
- **run.stage**：part1、split、part2 或 part3。
- **run.projectKey**：Work Automation 项目配置里的稳定 key，不是平台项目对象。
- **run.parentIssueId**：父事项的 opaque ID；没有父事项时必须显式写 null。
- **run.allowedOperations**：Agent 在结果中声明会使用的权限，必须是服务授权集合的子集。每项实际操作还必须同时存在于这个数组和服务授权集合中。
- **target.platform**：适配器注册 key，使用小写 ASCII 字母开头，可继续使用小写字母、数字、点、下划线和连字符，最长 64 个字符。协议不枚举具体厂商，新增平台只需注册新的适配器。
- **target.issueId**：由目标适配器解释的 opaque ID。
- **operations**：按输出顺序排列的操作。可以为空。
- **idempotencyKey**：同一结果内唯一，长度为 8 至 128，仅允许 ASCII 字母、数字、点、下划线、冒号、斜杠和连字符。

服务调用校验器时必须传入本次 run 的阶段、项目、父事项、目标和授权操作。结果中的绑定值与服务上下文逐项比较；Agent 不能通过修改 JSON 扩大权限或改写目标。

## 操作与 payload

| 操作 | 用途 | payload |
| --- | --- | --- |
| issue.read | 读取目标事项 | 可选 include，值只允许 comments、attachments、relations |
| comment.create | 新增评论 | 必填非空 body |
| issue.state.update | 更新状态 | 必填非空 state；适配器负责映射平台状态字段 |
| issue.child.create | 在目标事项下创建子事项 | 必填 title，可选 description |
| attachment.upload | 把本地文件附加到目标事项 | 必填 filePath，可选 filename、contentType、title |

操作 payload 只描述业务意图。平台 SDK 类型、专属状态 ID、上传会话、认证头和 MCP 配置都留在适配器或执行器内部，不属于 Agent 输出。

## 解析与校验

src/server/agent-result-protocol.mjs 提供两个无副作用入口：

    import { parseAgentResult, validateAgentResult } from "./agent-result-protocol.mjs"

    const context = {
      stage: "part2",
      projectKey: "work-automation",
      parentIssueId: "issue-parent",
      target: { platform: "primary-issues", issueId: "issue-1171" },
      allowedOperations: ["comment.create", "issue.state.update"],
    }

    const parsed = parseAgentResult(finalText, context)
    const validated = validateAgentResult(alreadyParsedObject, context)

成功结果是 { ok: true, value }，其中 value 只保留 v1 已知字段和显式扩展。失败结果是：

    {
      "ok": false,
      "error": {
        "code": "TARGET_MISMATCH",
        "path": "$.target",
        "message": "Agent 结果的目标与本次任务不一致。",
        "retryable": false
      }
    }

校验错误不会包含原始 JSON、实际字段值、provider response 或异常 cause。`UNKNOWN_FIELD` 的 path 只定位到包含未知字段的协议对象，不回显输入控制的字段名；extensions 校验错误同样不会把扩展 key 写入 path。稳定错误码包括：

- INVALID_JSON、MISSING_FIELD、INVALID_FIELD、UNKNOWN_FIELD
- UNKNOWN_VERSION、UNKNOWN_STAGE
- STAGE_MISMATCH、PROJECT_MISMATCH、PARENT_ISSUE_MISMATCH、TARGET_MISMATCH
- UNKNOWN_OPERATION、OPERATION_NOT_ALLOWED、DUPLICATE_OPERATION
- INVALID_IDEMPOTENCY_KEY、DUPLICATE_IDEMPOTENCY_KEY
- INVALID_CONTEXT，表示服务传入的校验上下文本身不合法

解析器只接受完整 JSON。现有 extractJson 从代码块或文字中猜测 JSON 的行为不能用于这个协议。

## 运行时接入

每次 run 会在 `run.json` 保存 `agentResultContext`，并在同一目录生成绑定当前阶段与目标的 `agent-result-schema.json`。Codex 以 `--output-schema` 和 `--output-last-message` 运行；正常结束和丢失进程恢复都使用同一个 v1 parser 校验 `final.txt`。

运行时输出 schema 使用严格生成所需的规范形式：`issue.child.create` 同时输出 `title` 和 `description`，`attachment.upload` 同时输出 `filePath` 和 `title`。v1 parser 仍保持上表定义的兼容性，接受省略这些可选字段的外部合法结果。

只有 Codex 进程成功结束、结果校验通过且已注册 operations 通过写后复查时，run 才能进入 `succeeded`。缺失结果、无效 JSON、未知版本或操作、阶段与项目不一致、父事项或目标不一致、未授权操作都会进入 `failed`。`run.json` 只保存规范化成功结果，或稳定错误码、路径和脱敏消息；原始 `final.txt` 作为运行产物保留，但不会被猜测或执行。

Codex 子进程使用受控环境变量集合，并通过 `--ignore-user-config` 阻止加载用户级 MCP 配置。Linear API key、配置的自定义 Linear 凭据变量、Linear MCP token 和未授权环境变量不会传入 supervisor 或 Codex；Codex 自身认证、PATH、临时目录、locale、代理和自定义 CA 等必要变量仍可用。

当前生产路径注册 `comment.create` 和 `issue.state.update`。执行器重新读取目标事项和项目，核对 run 绑定的项目、事项、团队、阶段输入状态和允许的目标状态；整个列表存在未注册操作或非法流转时，不调用任何 Linear mutation。阶段一不允许自动请求从 `Ready for Codex` 进入 `On Schedule`。

每项操作以 platform、projectKey、目标 issue、操作类型和 idempotencyKey 组成持久化作用域，记录在 `.linear-automation/issue-operations`。所有 intent 和顺序在第一项 mutation 前落盘；评论同时预分配 UUID v4。重放或服务重启时，执行器先用完整事项快照核对已生效操作，只恢复尚未确认的操作。评论按预分配 ID 和正文核对，状态按目标 state ID 和名称核对。

速率限制、瞬时网络和分页失败进入可恢复状态，不记录 processed issue 快照，也不重新运行 Codex。权限、归档、目标冲突、非法流转、已返回成功但写后复查未生效，以及无法判断副作用的失败进入人工处理终态。公开 run 和 event 只保存固定错误码与脱敏消息，不包含凭据、请求头或 provider 原始响应。

## 事项平台接口

服务读侧使用 `defineIssueReadAdapter` 约束统一接口：

    const readAdapter = defineIssueReadAdapter({
      platform: "primary-issues",
      readIssue,
      readProject,
      listProjectIssues,
      listProjectWorkflowStates,
      listProjectsWorkflowStates,
      listTeamWorkflowStates,
    })

`IssuePlatformIssue`、`IssuePlatformProject`、`IssuePlatformTeam`、`IssuePlatformState`、`IssuePlatformComment` 和 `IssuePlatformRelation` 只保留平台无关字段及 opaque 稳定 ID。事项包含 `target.platform` 与 `target.issueId`，供后续写入执行器绑定同一目标；关系同时保留相对当前事项的 `incoming` 或 `outgoing` 方向和对端事项 target。

项目事项、评论、关系、项目团队和工作流状态必须读完所有游标页后才返回。成功集合显式包含 `complete: true`，因此 `issues: []` 或 `teams: []` 表示完整的空结果；缺失或重复游标、后续页面失败及无效连接数据不会返回部分数组。队列扫描和状态健康检查必须拒绝 `complete: false` 的兼容输入。

src/server/issue-platform.mjs 定义五种固定操作的通用接口：

    const adapter = defineIssuePlatform({
      platform: "primary-issues",
      readIssue,
      createComment,
      updateIssueState,
      createChildIssue,
      uploadAttachment,
    })

每个方法接收同一种请求：

    {
      target: { platform, issueId },
      idempotencyKey,
      payload
    }

读取结果统一为 IssuePlatformIssue，评论、状态、子事项和附件分别返回协议中用 JSDoc 定义的通用对象。平台 SDK 客户端、凭据、原始响应和专属字段由闭包或适配器内部持有。Linear 当前通过 `linear-write-adapter.mjs` 注册评论和状态处理器；子事项与附件处理器注册前，执行器会拒绝包含它们的整个操作列表。

平台错误统一为：

    {
      "code": "PERMISSION_DENIED",
      "message": "当前身份不能执行该操作。",
      "operation": "comment.create",
      "path": "$.payload.body",
      "retryable": false
    }

可用错误码为 INVALID_REQUEST、NOT_FOUND、ARCHIVED、PERMISSION_DENIED、CONFLICT、RATE_LIMITED、UNAVAILABLE、PAGINATION_INTERRUPTED 和 OPERATION_FAILED。`ARCHIVED` 区分已归档目标与不存在目标，`PAGINATION_INTERRUPTED` 表示读取结果不完整；速率限制、瞬时网络失败和分页中断可以通过 `retryable` 决定是否重试。公开 message 由错误码决定，不接受适配器传入的 provider 诊断文本；具体响应和排障信息只能留在适配器内部日志中。公开 path 只保留 target、idempotencyKey 和已定义 payload 字段，其他路径统一收敛为 `$`。未映射异常经过 normalizeIssuePlatformError 时也只返回对应错误码的固定信息。错误对象没有凭据、请求头、MCP 配置或原始 cause 字段。

## 兼容规则

v1 默认严格校验字段，避免拼写错误或未知语义被静默执行。需要向后兼容的附加元数据必须放在 extensions JSON 对象中；根对象、run、target、单项操作及各操作 payload 都允许这个字段，解析器会保留其内容，但 v1 执行器不得据此扩大权限或改变操作语义。扩展数据最多嵌套 32 层，超过限制会被拒绝。

以下变化在 v1 内兼容：

- 在已有 extensions 中增加可忽略的 JSON 数据。
- 服务授权更多已有操作，而 Agent 仍声明并使用其中一个子集。
- operations 为空，表示本次 run 没有平台操作。

以下变化必须拒绝或使用新 schema 版本：

- 未知 schemaVersion、未知阶段或未知操作。
- 在 extensions 之外新增字段。
- 删除必填字段、改变字段类型或改变现有操作的 payload 语义。
- 修改项目、父事项或目标绑定。
- 声明或执行服务未授权的操作。
- 重复操作权限、无效幂等键或同一结果内重复幂等键。

新事项平台只需要实现相同五个方法并注册新的 platform key，不需要修改 Agent 结果的基础封装。新增操作会改变可执行语义，因此不能仅通过 extensions 引入，必须同时升级协议和执行器。
