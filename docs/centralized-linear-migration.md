# Linear 集中授权迁移

服务通过 `linear.apiKeyEnv` 指定的环境变量保管 Linear API key。Agent 只接收服务读取的事项快照和绑定当前运行的输出 schema；读取、评论、子事项和状态操作由服务执行。Agent 无需 Linear OAuth 登录，也不加载个人 MCP 配置。

## 升级已有安装

1. 在维护窗口停止旧服务，备份运行数据目录中的配置、提示词、`runs`、`issue-operations` 和 `processed.json`。不要在仍有旧进程写入时替换运行时文件。
2. 安装包含本次迁移的包。源码 checkout、全局 npm 包和后台服务指向的文件可能不同，应以 `wauto status` 的运行位置为准。
3. 保留服务端密钥环境变量和原有 `linear.apiKeyEnv`。配置示例只有变量名，不填写 key。`wauto setup` 管理服务环境文件；不得将密钥放入项目提示词或 Agent 输出。
4. 对照包内四份 `prompts/*.global.md` 更新运行目录中的提示词，并检查每个项目的覆盖提示词。旧提示词中的直接调用 Linear、OAuth 登录、上传附件说明必须替换为结构化结果协议；覆盖文件不会因升级被强制覆盖。
5. 运行配置校验、检查工作流状态，再启动服务。新运行绑定协议 v2；历史 v1 结果保持原语义。旧 `attachment.upload` 未注册，包含该操作的整批结果会在写入前拒绝。阶段三图片仅通过 `comment.create.payload.images` 声明。
6. 查看首个运行的“事项操作”页签：应先有事项读取及目标校验，再有写入和 `verified` 记录。进程退出码为 0、provider 返回成功都不能替代最终核对。

不需要为自动化 Agent 恢复旧的 Linear MCP 登录。服务端认证失败应检查服务的环境变量、key 权限和目标可访问性。旧 `codex-linear-auth-required` 运行保留历史信息，但不再有专门的 OAuth 自动重试逻辑；需要重试时从界面重新运行事项。

macOS 的项目、Codex 工作目录和运行数据目录不能放在 `/tmp`（真实路径 `/private/tmp`）下，也不能通过符号链接指向那里。真实验收发现本机 Codex CLI 0.153.4 在此目录中未落实只读限制，即使 profile 声明 `:slash_tmp = deny` 仍允许写入。runner 会在写提示词和启动进程前拒绝这类配置；本次真实验收改用 macOS 用户临时目录，并通过了读写边界检查。

## 审计与失败恢复

逐次调用和操作状态写入 `.linear-automation/issue-audit/<SHA-256(runId)>.jsonl`，并同步到事件日志。扫描阶段尚无 run，写入 `SHA-256("scan")` 文件，runId 为 null；项目批量健康检查可能没有单个 issue 或 projectKey。运行绑定后的读取、写入、恢复带 runId、阶段、平台、项目、issue、操作类型、幂等键、尝试 ID、结果、错误码与失败来源。只保存元数据，不记录正文、图片字节、请求头或原始 provider 响应。读取的幂等键用于追溯，不缓存或跳过读取。

本地详情接口返回 `audit`，运行详情的“事项操作”页签展示记录。`started` 表示调用前审计落盘，`succeeded` 表示平台调用返回，`verified` 才表示写后核对通过。中断后只有 started 的调用可以和持久化 intent、稳定 UUID 及远端记录对照。不会为升级前运行补造历史审计。

- `agent-output`：缺失、非法或与运行绑定不符的结构化输出，未执行写入。
- `service-validation`：越权目标、错误状态、未注册操作、图片路径或内容不合规，或远端内容与 intent 冲突。检查声明和远端记录。
- `provider`：Linear 权限、限流、网络或写后读取失败。可重试的操作保留 run 和幂等记录，恢复时先查远端，已核对的评论或子事项不会重建。

审计与事件日志做凭据脱敏。运行原始 stdout、stderr、final 和提示词仍属于本地受限产物；详情响应会脱敏，但这不代替磁盘访问控制，不应公开运行目录。不要删除 `issue-operations` 来“修复”失败：它保存稳定评论及子事项 ID、图片指纹和部分成功状态。无法核对的图片评论交人工处理，避免重复写入。

## 评论图片

保持 LIV-1176 的用户决策：只创建带图片的评论，不调用 fileUpload 或 attachmentCreate，不管理独立资产。PNG/JPEG 单文件最多 64 KiB，每 run 最多四张且总量 256 KiB；整条编码正文最多 100000 字符，所以四张满额图片不能放在一条评论里。路径必须在当前 run 内，服务端计算 MIME、大小和 SHA-256。页面实测见 [评论图片验证](linear-comment-images-smoke.md)。

## 回滚与发布检查

回滚前停止新服务并保留全部数据副本。旧版本不能安全消费新的结构化结果和幂等记录；不要让旧的 Agent 直写模式与服务写入模式同时运行。恢复旧安装时应人工核对尚未完成的写入，不能清空日志后自动重跑。

发布验证顺序为 `pnpm test`、`pnpm build`、`pnpm npm:check`。包检查实际生成并解压读取 tgz，核对前端构建、四阶段提示词、协议、适配器、执行器、审计模块与迁移文档，拒绝环境文件、运行目录、测试文件、旧认证诊断及凭据特征。检查使用临时目录，不发布包；CI 在 publish 前执行同一检查。静态特征扫描不能证明任意文本中绝不存在所有形式的秘密，发布仍依赖明确的 files 白名单。

四阶段集成回归使用真实子进程、环境过滤、协议校验、读写适配器和持久化执行器，Linear 边界使用 fake GraphQL。另有 runner/supervisor 的沙箱及凭据隔离测试。这些测试不代表生产 Linear mutation 或部署验收。

## 本次验收记录（2026-09-16）

`pnpm test` 全仓 273 项通过，包含真实 macOS 沙箱及本机 HTTP/Webhook 测试；受限沙箱内首次运行曾因嵌套沙箱及端口监听权限失败，正常本机权限复跑通过。`pnpm build` 与改动文件 ESLint 通过。实际 npm 压缩包检查通过，本地页面截图目录从发布包中排除。

使用独立临时数据目录与合成运行记录，打开运行详情并切换“事项操作”，确认可同时看到已核对评论的稳定 ID、失败状态操作的幂等键、平台失败分类及等待自动恢复提示。见 [页面截图](evidence/liv-1177/audit-ui.png)。预览未启动调度、未持有 Linear 凭据，也没有调用真实 Linear 写入接口。

### 开发项目真实验收

用户授权后，在开发配置的「wa测试」项目调用真实 Linear API；未变更正在运行的 4378 服务及其项目配置。以下四个测试使用真实 Codex CLI、服务端读写适配器和执行器。Codex 在临时 fixture 仓库执行环境和权限检查，再输出受运行绑定约束的操作。它的环境没有 Linear/MCP 凭据，不能读取服务环境文件、服务配置或个人 Codex 配置。

| 阶段 | 测试事项 | 真实写入与回读结果 |
| --- | --- | --- |
| part1 | [LIV-1190](https://linear.app/livehappy-workhappy/issue/LIV-1190) | 一条评论，Todo 改为 Ready for Codex |
| split | [LIV-1191](https://linear.app/livehappy-workhappy/issue/LIV-1191) | 创建 LIV-1192，核对父事项、团队、项目和优先级；一条覆盖评论，状态 In Progress |
| part2 | [LIV-1193](https://linear.app/livehappy-workhappy/issue/LIV-1193) | Codex 写入 fixture 文件；一条评论，On Schedule 改为 Testing |
| part3 | [LIV-1194](https://linear.app/livehappy-workhappy/issue/LIV-1194) | 一条带 PNG 的评论，回读并核对图片指纹，Testing 改为 Ready for Review |

split 和 part3 在真实 provider 写入后、持久化成功状态前注入异常。重新打开 store 后恢复，没有重复子事项或评论；删除 part3 本地图片后仍可通过远端核对重放。随后另起 Node 进程，重读四个落盘 run 再次重放，均通过。这里的故障是注入的进程内异常，不是让 Linear 实际限流或让操作系统崩溃。证据见 [真实操作记录](evidence/liv-1177/live-operations.json)。

[LIV-1196](https://linear.app/livehappy-workhappy/issue/LIV-1196) 验证非法 schema、跨事项目标、旧 attachment.upload、越界图片、绝对图片路径和不允许的目标状态。六项均被拒绝，真实事项保持零评论和 Testing。另用刻意无效的测试 key 请求真实 Linear，审计记录 PERMISSION_DENIED 和 provider 分类，未记录认证值。见 [失败关闭记录](evidence/liv-1177/live-negative.json)。

运行详情的“事项操作”页签也使用上述真实运行数据复核，能够看到稳定评论 ID、图片回读、状态核对及新进程重放的记录。见 [真实运行页面截图](evidence/liv-1177/live-audit-ui.png)。

真实测试暴露并修正两处权限问题：macOS `/tmp` 下的只读限制未生效，runner 现在拒绝相关目录及符号链接；阶段二原本无法创建 `.git/index.lock`，现在只对阶段二显式允许仓库内 `.git` 写入。新增真实沙箱测试执行 `git add` 和 `git commit`，同时检查其余阶段仍不能写 Git 元数据，所有阶段仍不能读项目 `.env.local`。

另用源码调度器、原版三阶段提示词和真实 Codex 执行 [LIV-1195](https://linear.app/livehappy-workhappy/issue/LIV-1195) 的完整代码修复流程，未预设 Agent 的结果 JSON。它在无远端的独立临时仓库中分析 greet 的空白输入缺陷，由验收脚本执行本次授权的 On Schedule 交接，随后修复两个文件并创建提交 `34de9ad`，最后自动 review 移到 Ready for Review。实现测试 6/6 通过，review 对父提交和实现提交执行同一组 6 个输入，结果分别为 1/6 和 6/6 符合新需求；工作树干净。首次阶段二因 Git 元数据权限失败而正确写回 Blocked，修复服务权限后在同一事项继续通过。见 [调度记录](evidence/liv-1177/live-scheduler.json) 和 [真实 review 摘要](evidence/liv-1177/live-review/summary.md)。

本机仍有环境限制：Codex WebSocket 连接遇到证书错误后回退 HTTPS，中途出现一次 SSE 空闲超时并自动重连；Git 工具链产生缓存权限警告，Node 的裸命令子进程查找也曾返回 EPERM。review 改用独立 shell 命令后完成实际检查，相关失败与成功日志均保留。未通过扩大沙箱权限来消除这些环境提示，不能据此宣称任意工具调用方式都已通过。

全部断言结束后，将本次创建的七个测试事项保留并收尾到 Ready for Review，避免开发轮询再次执行。上表和失败关闭记录描述的是收尾前的验收状态，状态历史仍可核查，见 [样例收尾记录](evidence/liv-1177/live-cleanup.json)。对本次运行目录内 120 份文本产物检查服务端实际 API key，未发现匹配，见 [检查结果](evidence/liv-1177/live-secret-scan.json)。这次验证的是本地源码和测试项目；未发布 npm 包，也未替换已安装的后台服务。
