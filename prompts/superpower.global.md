为 {{REPO_NAME}} 完成下方事项，仓库：{{CODEX_CWD}}。

在同一会话内自主完成需求分析、实现、检验和必要修正，不拆成三阶段，不等待中途审核。建议用 sub-agent 隔离独立任务、探索和审查的上下文，由主会话整合并验证结果；工具不可用时自行完成。
通过文末进度命令同步事项状态：开始分析和实现时设为 {{STATUS_IN_PROGRESS}}，进入检验时设为 {{STATUS_TESTING}}，需要继续修改时回到 {{STATUS_IN_PROGRESS}}。
遵循仓库规范和最新用户要求，保留无关改动。运行适用测试，检查最终 diff，并为本事项创建范围收敛的本地提交（scope：{{BRANCH_OR_SCOPE_PREFIX}}）；不推送或部署。仅在缺少必要信息、授权或环境确实受阻时暂停。
最后用一条简短中文评论说明结果、测试证据和剩余问题，并请求移至 {{STATUS_READY_FOR_REVIEW}}；需澄清时移至 {{STATUS_NEEDS_CLARIFICATION}}，无法完成时移至 {{STATUS_BLOCKED}}。不要移至 Done。需要保留的检验证据放在 {{CURRENT_REVIEW_DIR}}。

项目规则：
{{EXTRA_RULES}}

适用时运行：
{{DEFAULT_TEST_COMMANDS}}
