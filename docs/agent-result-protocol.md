# Agent 结构化结果协议 v2

这份协议定义 Work Automation 四个处理阶段与 Codex Agent 之间的结果边界，以及服务内部统一的事项平台接口。调度器会把运行绑定和事项快照交给 Agent，校验并保存最终结果，再受控执行已注册的事项平台操作。

## 结果封装

Agent 最终输出必须是单个 JSON 文档，不能带 Markdown 代码块或说明文字。新运行使用 schemaVersion 为字符串 "2"，新运行上下文固定版本以拒绝降级，旧运行仍可按未绑定版本的历史上下文提交严格 v1 结果：

    {
      "schemaVersion": "2",
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

- **schemaVersion**：接受字符串 "1" 和 "2"，不将旧结果自动改写成 v2。
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
| comment.create | 新增评论 | 必填非空 body；v2 的 part3 可带有序 images，每项仅含 filePath 和可选 caption |
| issue.state.update | 更新状态 | 必填非空 state；适配器负责映射平台状态字段 |
| issue.child.create | 在目标事项下创建子事项 | 必填 title；split 运行时还要求非空 description |
| attachment.upload | 保留旧合同，未注册执行器 | 必填 filePath，可选 filename、contentType、title；新运行不再授予该操作，旧结果包含它时仍整批拒绝 |

操作 payload 只描述业务意图。平台 SDK 类型、专属状态 ID、上传会话、认证头和 MCP 配置都留在适配器或执行器内部，不属于 Agent 输出。

## 评论图片文件与容量边界

v2 阶段三评论示例：

```json
{
  "type": "comment.create",
  "idempotencyKey": "issue-1176:part3:review",
  "payload": {
    "body": "Codex Auto Review Complete\n\nReview 摘要：检查通过。",
    "images": [{ "filePath": "review/gui/after.png", "caption": "操作后的界面" }]
  }
}
```

服务端只从当前 run.dir 读取普通、单链接文件。路径必须是规范的相对路径，拒绝绝对路径、点路径分量、路径穿越、根目录及内部路径分量的符号链接、硬链接、目录、FIFO 和设备文件。通过 lstat、realpath、O_NOFOLLOW、O_NONBLOCK、文件句柄 fstat 和前后身份核对收紧读取竞争窗口；字节数受限，所有图片预检通过、intent 落盘后，整批再次核对校验和才开始 mutation。最终请求始终使用预检时那份字节。此检查不构成针对同一 OS 用户恶意进程的内核级文件隔离。

仅接受可解码的 PNG/JPEG，通过内容探测 MIME，服务端计算大小和 SHA-256。PNG 检查 CRC、完整文件边界并限制解压量，不接受 APNG；解码像素最多 16 Mi，JPEG 另有 128 MiB 解码预算。v2 body 不允许内嵌图片 Markdown、img 标签或 data URI，图片只能通过 images 声明。

默认限制集中在 `RUN_IMAGE_LIMITS`：单文件 64 KiB，每 run 四张、总计 256 KiB；编码后每条评论最多 100000 个 UTF-16 代码单元（对补充平面字符采取保守计数），整条 GraphQL JSON 请求最多 512 KiB。所有评论在批次预检中检查正文长度，图片正文还检查编码后的长度与请求字节预算。数量、文件大小通过不代表长正文或多图一定能放进一条评论。

2026-09-13 在 LIV-1176 实测：小 PNG 与 JPEG 同评论写入、64 KiB PNG 写入通过；5 MiB 和 1 MiB 请求被拒绝；80 KiB 请求返回 `body must be shorter than or equal to 100000 characters`。因此按用户允许的收紧规则采用 64 KiB，5 MiB 仅为原始目标，不是 Linear 接口限额。官方说明允许在评论 Markdown 嵌入 base64 图片，存储认证仅支持 Linear 自有地址：[文件上传说明](https://linear.app/developers/how-to-upload-a-file-to-linear)、[存储认证](https://linear.app/developers/file-storage-authentication)。

## 图片评论恢复与核对

图片 intent 复用稳定评论 UUID，额外持久化有序文件清单、caption、实际 MIME、字节数、SHA-256 和编码请求指纹。同键改变正文、声明顺序、说明或文件内容均报告冲突。尚未尝试写入时需要原文件存在并与 manifest 一致；已尝试写入时先保留原 intent，文件仍在则核对内容，文件缺失不阻止按远端 UUID 恢复。操作日志不保存凭据。

首次写入、响应丢失和跨重启恢复共用核对：检查目标 issue 中的评论 UUID、文字、图片数量与顺序，再核对每张图字节数和 SHA-256。data URI 直接核对；托管引用只允许 HTTPS 的 `uploads.linear.app`，拒绝用户信息、端口、查询参数及跳转，服务客户端闭包持有认证信息并限量读取。引用不合法、缺图、错序、正文或图片不一致时保留稳定 ID 和人工处理原因，不把“评论存在”视为成功。平台若重编码图片且字节不同，会保守转人工处理。

成功响应的正文保存在 provider 记录中，独立重读仍是成功前提。图片读取限流可重试读取；已经尝试过图片 mutation 的操作不会自动再次创建评论。如果响应不明且按 UUID 查不到评论，则保留记录交人工判断。这样牺牲少量自动重试以避免无法追踪的重复图片写入。评论已核对但后续状态失败时仅恢复状态；provider-succeeded 不降级成可重发评论。

不调用 fileUpload 或 attachmentCreate，不创建或删除独立资产、不删除或重建评论。Linear 为显示评论图片进行的内部存储由平台处理。图片操作未全部完成时保留 review 临时产物，包括人工处理和取消状态；完成后恢复已有临时目录清理规则。

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

成功结果是 { ok: true, value }，其中 value 只保留对应版本的已知字段和显式扩展。失败结果是：

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

每次 run 会在 `run.json` 保存 `agentResultContext`，并在同一目录生成绑定当前阶段与目标的 `agent-result-schema.json`。Codex 以 `--output-schema` 和 `--output-last-message` 运行；正常结束和丢失进程恢复都使用同一个支持 v1/v2 的 parser 校验 `final.txt`。

运行时输出 schema 使用严格生成所需的规范形式：`issue.child.create` 同时输出 `title` 和 `description`，part3 的 `comment.create` 同时输出 `body` 和 `images`，每张图片同时输出 `filePath` 和 `caption`；无图片用空数组，无说明用空字符串。解析器允许省略可选字段。其他阶段不能声明 images。旧 v1 的 comment.create 仍只接受 body 和 extensions，不经 extensions 引入图片语义。

只有 Codex 进程成功结束、结果校验通过且已注册 operations 通过写后复查时，run 才能进入 `succeeded`。缺失结果、无效 JSON、未知版本或操作、阶段与项目不一致、父事项或目标不一致、未授权操作都会进入 `failed`。`run.json` 只保存规范化成功结果，或稳定错误码、路径和脱敏消息；原始 `final.txt` 作为运行产物保留，但不会被猜测或执行。

Codex 子进程使用受控环境变量集合，并通过 `--ignore-user-config` 阻止加载用户级 MCP 配置。Linear API key、配置的自定义 Linear 凭据变量、Linear MCP token 和未授权环境变量不会传入 supervisor 或 Codex；Codex 自身认证、PATH、临时目录、locale、代理和自定义 CA 等必要变量仍可用。

当前生产路径注册 `issue.child.create`、`comment.create` 和 `issue.state.update`。执行器重新读取目标事项和项目，核对 run 绑定的项目、事项、团队、阶段输入状态和允许的目标状态；整个列表存在未注册操作或非法流转时，不调用任何 Linear mutation。阶段一不允许自动请求从 `Ready for Codex` 进入 `On Schedule`。子事项批次只允许出现在 split 阶段，所有创建操作必须排在评论和状态操作之前，覆盖评论必须与每个子事项的 idempotencyKey 一一对应，批次目标状态固定为配置的 `In Progress`。

每项操作以 platform、projectKey、目标 issue、操作类型和 idempotencyKey 组成持久化作用域，记录在 `.linear-automation/issue-operations`。所有 intent 和顺序在第一项 mutation 前落盘；评论和子事项同时预分配 UUID v4。子事项 intent 还记录父事项、团队、项目、优先级及规范化请求指纹。重放或服务重启时，执行器先用完整事项快照核对已生效操作，只恢复尚未确认的操作。评论按预分配 ID 和正文核对，状态按目标 state ID 和名称核对；子事项按预分配 ID 读取，并逐项核对 parent、team、project、priority、title 和 description。执行结果为已核对的子事项返回并持久化真实 issue ID，部分批次失败时保留前面各项的 verified 结果。

速率限制、瞬时网络和分页失败进入可恢复状态，不记录 processed issue 快照，也不重新运行 Codex。子事项写入响应丢失时，恢复路径先按预分配 ID 查询，已存在且字段一致则直接标记 verified；不存在时仍使用同一个 ID 安全重试。权限、归档、目标冲突、非法流转、写后字段不一致，以及无法判断副作用的失败进入人工处理终态。公开 run 和 event 只保存固定错误码与脱敏消息，不包含凭据、请求头或 provider 原始响应。

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

读取结果统一为 IssuePlatformIssue，评论、状态、子事项和附件分别返回协议中用 JSDoc 定义的通用对象。平台 SDK 客户端、凭据、原始响应和专属字段由闭包或适配器内部持有。Linear 当前通过 `linear-write-adapter.mjs` 注册子事项、评论和状态处理器；附件处理器注册前，执行器会拒绝包含该操作的整个操作列表。

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
