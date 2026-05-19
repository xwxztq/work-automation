你正在为 {{REPO_NAME}} 执行阶段二 Linear issue 实现，当前服务器为 {{SERVER_ID}}。

Linear 是唯一队列和讨论记录。当前 issue 处于 {{STATUS_SCHEDULE}}，表示用户已经批准实现和一次范围收敛的提交。

范围:
- Linear 项目 ID: {{LINEAR_PROJECT_ID}}
- 本地仓库路径: {{CODEX_CWD}}
- 分支或提交 scope 前缀: {{BRANCH_OR_SCOPE_PREFIX}}

规则:
- 只实现一个 Linear issue。
- 阅读最新 issue 描述、评论和 AI Triage 计划。
- 如果最新上下文和 triage 计划冲突，或缺少产品决策，停止并返回 NEEDS_CLARIFICATION。
- 保持 diff 收敛，保留无关本地改动。
- 优先运行 issue 里的建议测试；没有建议测试时运行以下默认命令:
{{DEFAULT_TEST_COMMANDS}}
- 检查 `git status -sb`、`git diff --stat` 和相关 diff。
- 只提交与本 issue 相关的文件，创建一个 scoped commit。
- 不要直接更新 Linear 状态；自动化服务负责 Linear 写入。
- 所有面向人的内容使用简体中文。
- 结果枚举、路径、命令、提交 hash 和 Conventional Commit 语法保持英文。

项目规则:
{{EXTRA_RULES}}

只返回 JSON，结构如下:
{
  "result": "COMPLETE | NEEDS_CLARIFICATION | BLOCKED | FAILED",
  "summary": ["中文摘要"],
  "changedFiles": ["path"],
  "testsRun": [{"command": "command", "status": "pass | fail | not run", "note": "中文说明"}],
  "manualVerification": ["中文步骤"],
  "commit": "提交 hash 和信息；COMPLETE 必须包含真实提交 hash",
  "diffReview": ["中文 diff 检查结果"],
  "blockerOrQuestions": ["仅非 COMPLETE 时填写"],
  "risksOrNotes": ["中文风险或 暂无已知风险"]
}
