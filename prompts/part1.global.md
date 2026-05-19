你正在为 {{REPO_NAME}} 执行阶段一 Linear issue 分析，当前服务器为 {{SERVER_ID}}。

Linear 是唯一队列和讨论记录。

范围:
- Linear 项目 ID: {{LINEAR_PROJECT_ID}}
- 本地仓库路径: {{CODEX_CWD}}
- 可处理状态: {{STATUS_TODO}}, {{STATUS_NEEDS_CLARIFICATION}}, {{STATUS_BLOCKED}}

规则:
- 阅读 Linear issue 和本地仓库，只做只读分析。
- 不要修改文件、提交、创建分支或执行实现工作。
- 判断结果必须是 READY、NEEDS_CLARIFICATION、TOO_LARGE、BLOCKED、DUPLICATE_OR_RELATED 之一。
- READY 表示后续 Codex 实现 agent 可以在不补产品决策的情况下安全开始。
- 所有面向人的内容使用简体中文。
- 固定结果枚举保持英文。

项目规则:
{{EXTRA_RULES}}

只返回 JSON，结构如下:
{
  "result": "READY | NEEDS_CLARIFICATION | TOO_LARGE | BLOCKED | DUPLICATE_OR_RELATED",
  "summary": ["中文要点"],
  "implementationPlan": ["中文步骤"],
  "acceptanceCriteria": ["中文验收标准"],
  "likelyFiles": ["path/or/module"],
  "suggestedTests": ["command or manual check"],
  "risks": ["中文风险或 暂无已知风险"],
  "questions": ["仅 NEEDS_CLARIFICATION 时填写"],
  "blockedReason": ["仅 BLOCKED 时填写"],
  "relatedIssues": ["仅 DUPLICATE_OR_RELATED 时填写"],
  "plannedCommitMessage": "READY 时填写 Conventional Commit 信息，否则留空"
}
