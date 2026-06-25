# Auto Review 协议与产物基线

这份文档定义 Work Automation 阶段三 Auto Review 的输入、基线来源、成功/失败判定、产物命名和 Linear 评论约定。目标是让后续调度骨架和执行器实现时，直接复用同一份仓库内协议。

## 目标与边界

- 阶段三只认领当前处于 `Testing` 的 issue。
- 阶段三默认只做 review、评论和状态流转，不主动修改业务代码，也不创建新提交。
- 阶段三的唯一状态出口是:
  - `Ready for Review`: review 完成，具备人工验证的最小条件。
  - `On Schedule`: review 已完成，但发现需要返工的问题。
  - `Blocked`: 缺少上下文、权限、环境或基线，无法得出可信结论。
- Linear 仍然是 issue 上下文、用户决策和最终状态的唯一来源。

## 当前仓库已存在的能力

- 阶段状态名已在 `README.md` 和 `src/server/defaults.mjs` 中定义，包含 `Testing` 和 `Ready for Review`。
- 提示词与调度器已为阶段三提供专用上下文，见 `prompts/part3.global.md` 与 `src/server/scheduler.mjs`。
- 每次运行都会在 `.linear-automation/runs/<run-id>/` 下落基础文件，当前固定包含:
  - `prompt.md`
  - `stdout.jsonl`
  - `stderr.log`
  - `final.txt`
  - `run.json`
- 阶段三执行器会把当前 `part3` run 目录、review 目录、最新实现交接评论和实现后用户评论显式传给 Codex agent，便于按协议生成 review 产物。
- 默认 `part3Sandbox` 使用 `danger-full-access`，因为 review 产物需要写入 Work Automation 仓库中的当前 run 目录，而阶段三的 `codex -C` 可能指向其他业务仓库。提示词必须继续约束 agent 只写当前 run 目录，不改业务代码。

## 阶段三输入协议

阶段三实现至少要读取并校验以下输入:

1. Linear issue 当前状态必须是 `Testing`。
2. 最新用户上下文:
   - issue 标题、描述、标签、优先级、最新评论
   - 最新 `Codex Implementation Complete` 评论
3. 本地仓库上下文:
   - 实现提交 hash
   - 当前仓库 HEAD 与工作树状态
   - 相关测试、脚本、fixture、文档或 issue 附件
4. 当前 run 目录基础文件:
   - `.linear-automation/runs/<part3-run-id>/run.json`
   - `.linear-automation/runs/<part3-run-id>/prompt.md`
   - 需要时读取 `stdout.jsonl`、`stderr.log`、`final.txt`

如果缺少 `Codex Implementation Complete` 评论、缺少实现提交信息，或仓库状态无法映射到要 review 的实现结果，阶段三应进入 `Blocked`，不要猜测。

## 基线来源规则

阶段三必须先确定“比较基线”来自哪里，再决定产物要求。统一按下面顺序解析:

1. 最新用户评论、issue 描述、附件、验收标准。
2. 最新 `Codex Implementation Complete` 评论里的提交、测试和手动验证说明。
3. 实现提交的父提交 `<implementation-commit>^`。
4. 仓库内已有 fixture、快照、样例文件、设计文档或 issue 中引用的现存产物。

如果多个来源冲突，优先级为:

1. 最新用户评论
2. issue 描述 / 验收
3. 最新实现评论
4. AI Triage 计划
5. 旧产物或旧文档

基线类型统一分为三类:

- `commit-parent`: 已有功能的修改、修复或回归检查。基线来自实现提交的父提交。
- `artifact-reference`: 之前已经存在可信的样例、截图、设计稿、fixture 或 issue 附件，优先复用这些现成产物。
- `spec-only`: 新功能没有可运行的“before”版本，基线只来自 issue 需求、验收和设计说明。

如果无法确定基线类型，或现有来源不足以支撑 review 结论，阶段三应移动到 `Blocked`。

## GUI 类功能产物要求

### 已有页面 / 交互改动

- 基线类型: `commit-parent` 或 `artifact-reference`
- 最少产物:
  - 同一页面或交互场景的 `before` 截图
  - 同一场景的 `after` 截图
  - `summary.md` 中的差异说明
- 额外要求:
  - 如果改动涉及多步流程、弹窗、拖拽、动画、状态切换或一次截图无法表达的行为，补充 `flow.gif` 或逐步截图序列。
  - `before` 与 `after` 需要尽量保持同一路径、同一数据状态、同一视窗尺寸。

### 新页面 / 新交互

- 基线类型: `spec-only`
- 最少产物:
  - `after` 截图
  - `summary.md` 中写明“新增功能，无 before 基线，按需求 / 设计验收”
- 额外要求:
  - 多步流程、动效或显著交互变化时，补充 `flow.gif` 或逐步截图序列。

## 算法 / API 类功能产物要求

### 已有接口 / 算法改动

- 基线类型: `commit-parent` 或 `artifact-reference`
- 最少产物:
  - 同一输入样例
  - `before` 输出
  - `after` 输出
  - `diff.md` 中的结论
- 输入样例来源优先级:
  1. issue 描述或评论明确给出的复现输入
  2. 已存在测试、fixture、快照
  3. 实现评论里提到的手动验证样例

### 新接口 / 新算法

- 基线类型: `spec-only`
- 最少产物:
  - 至少一组代表性输入
  - 对应输出
  - `summary.md` 中写明样例来源和验收依据
- 如果没有“before”输出，不要伪造空白文件，直接在 `manifest.json` 和 `summary.md` 里记录 `spec-only`。

## 产物目录与命名

阶段三新增的 review 产物统一放在当前阶段三 run 目录下:

```text
.linear-automation/runs/<part3-run-id>/
  prompt.md
  stdout.jsonl
  stderr.log
  final.txt
  run.json
  review/
    manifest.json
    summary.md
    gui/
      <scenario-slug>.before.png
      <scenario-slug>.after.png
      <scenario-slug>.flow.gif
      <scenario-slug>.notes.md
    api/
      <scenario-slug>.input.json
      <scenario-slug>.before.json
      <scenario-slug>.after.json
      <scenario-slug>.diff.md
```

命名规则:

- `scenario-slug` 使用小写 ASCII、数字和连字符，例如 `login-modal`、`referral-api-duplicate-email`。
- 同一场景的相关文件必须共用同一个 `scenario-slug`。
- 非 JSON 输出按实际格式改用 `.txt`、`.html` 或其他可读扩展名；不要为了统一命名强行改内容格式。
- 如果场景没有 `before`，不要创建空文件，用 `manifest.json` 标记 `baselineType: "spec-only"`。

`manifest.json` 至少包含这些字段:

```json
{
  "issueIdentifier": "LIV-123",
  "stage": "part3",
  "implementationCommit": "abc1234",
  "baselineType": "commit-parent",
  "baselineSource": "Codex Implementation Complete comment / commit parent / fixture",
  "result": "ready-for-review",
  "artifacts": [
    "review/summary.md"
  ]
}
```

## Linear 评论与状态流转规则

阶段三评论必须保留英文 marker 行，并用简体中文写其余内容。评论里需要引用 review 产物的仓库相对路径。

### `Ready for Review`

- marker: `Codex Auto Review Complete`
- 状态: `Ready for Review`
- 适用条件:
  - 已确认基线来源
  - 已完成最小 review 检查
  - 必要产物已生成，或当前问题类型无需额外采样
  - 没有发现会阻止人工验证的明显问题

### `On Schedule`

- marker: `Codex Auto Review Rework`
- 状态: `On Schedule`
- 适用条件:
  - review 已完成
  - 发现实现与需求不符、测试不通过、关键信息不一致，或缺少实现方应当补齐的产物
  - 问题可以通过再次实现解决，不需要额外外部权限或用户决策

### `Blocked`

- marker: `Codex Auto Review Blocked`
- 状态: `Blocked`
- 适用条件:
  - 缺少可信基线
  - 无法取得环境、账号、依赖服务或必要权限
  - 无法定位实现提交、运行产物或 issue 上下文
  - 无法在不猜测的前提下做出 review 结论

`On Schedule` 与 `Blocked` 的区别:

- `On Schedule` 是实现需要返工。
- `Blocked` 是 reviewer 无法形成可信判断。

## 评论字段约定

为便于后续执行器直接生成评论，阶段二和阶段三评论应补齐以下字段:

- 阶段二 `Codex Implementation Complete`
  - `提交`: 必须包含实现 commit hash
  - `手动验证`: 需要写清页面路径、操作步骤，或 API / 算法输入输出样例来源
  - `Review 基线`: 新功能写 `spec-only`；改动已有功能写 `commit-parent` 或现有产物路径
- 阶段三所有结果评论
  - `Review 产物`: 引用 `review/summary.md` 和关键对比文件的相对路径；若未生成，明确写 `无`

## 最小落地要求

在 AGU-8 / AGU-10 真正实现前，仓库内至少要保持以下约定成立:

- `README.md`、提示词和默认状态名使用同一套状态词汇。
- 阶段二评论能够提供 review 需要的提交和基线线索。
- 阶段三评论能够明确指出 review 产物路径或缺失情况。
- review 产物永远放在当前阶段三 run 目录下，不写回业务仓库的其他位置。
