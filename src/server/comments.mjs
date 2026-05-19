export function renderPart1Comment(result, statuses) {
  const data = normalizeResult(result)
  switch (data.result) {
    case "READY":
      return `AI Triage: READY

摘要:
${list(data.summary)}

实现计划:
${numbered(data.implementationPlan)}

验收标准:
${list(data.acceptanceCriteria)}

可能涉及文件或区域:
${list(data.likelyFiles)}

建议测试:
${list(data.suggestedTests)}

计划提交信息:
${data.plannedCommitMessage || "未提供"}

风险:
${list(data.risks)}

如何继续:
如果希望 Codex 开始实现，请把这个事项移动到 \`${statuses.schedule}\`。`
    case "NEEDS_CLARIFICATION":
      return `AI Triage: NEEDS CLARIFICATION

这个事项目前还不能安全实现。

需要确认:
${numbered(data.questions)}

为什么阻塞实现:
${list(data.summary)}

如何继续:
请在这个事项里回复，或直接补充描述。缺失信息补齐后，可以留在 \`${statuses.needsClarification}\`，或移回 \`${statuses.todo}\` 进入下一轮 triage。`
    case "TOO_LARGE":
      return `AI Triage: TOO LARGE

这个事项对单次 Codex 实现来说范围过大。

建议拆分:
${numbered(data.implementationPlan)}

原因:
${list(data.summary)}

推荐下一步:
请拆成更小的 issues，或收窄这个 issue 的范围，然后把可执行项移动到 \`${statuses.todo}\`。`
    case "BLOCKED":
      return `AI Triage: BLOCKED

阻塞原因:
${list(data.blockedReason.length ? data.blockedReason : data.summary)}

解除阻塞后:
请补齐依赖、权限、配置或前置决策，然后把 issue 移回 \`${statuses.todo}\` 或 \`${statuses.needsClarification}\`。`
    case "DUPLICATE_OR_RELATED":
      return `AI Triage: DUPLICATE OR RELATED

可能相关的 issue:
${list(data.relatedIssues)}

原因:
${list(data.summary)}

推荐下一步:
请确认是否关联、合并、关闭或保留这些事项。服务不会自动关闭或合并。`
    default:
      return `AI Triage: NEEDS CLARIFICATION

这个事项目前还不能安全实现。

需要确认:
- Codex triage 返回了无法识别的结果：${data.result || "空"}`
  }
}

export function renderHandoffComment(issue, project, statuses) {
  return `Codex Handoff

已认领并开始实现。

来源:
- Linear 事项: ${issue.identifier} / ${issue.title}
- 项目 / 仓库: ${project.repoName}

实现要求:
- 遵循最新 issue 描述、评论和 AI Triage 计划。
- 改动范围只覆盖这个事项。
- 不要包含无关本地改动。
- 运行建议测试；如果无法运行，需要说明原因。
- 完成后需要创建一个只包含相关改动的 scoped commit。

完成要求:
- 将这个 issue 移动到 \`${statuses.testing}\`。
- 评论需要包含摘要、变更文件、测试、手动验证、提交和已知风险。`
}

export function renderPart2Comment(result, statuses) {
  const data = normalizeResult(result)
  if (data.result === "COMPLETE") {
    return `Codex Implementation Complete

摘要:
${list(data.summary)}

变更文件:
${list(data.changedFiles)}

测试:
${tests(data.testsRun)}

手动验证:
${numbered(data.manualVerification)}

提交:
${data.commit || "未提供"}

Diff 检查:
${list(data.diffReview)}

风险 / 备注:
${list(data.risksOrNotes)}

状态:
已移动到 \`${statuses.testing}\`，等待人工验证。`
  }
  if (data.result === "NEEDS_CLARIFICATION") {
    return `Codex Implementation Needs Clarification

我在完成实现前停止，因为最新 issue 上下文需要用户确认。

需要确认:
${list(data.blockerOrQuestions)}

已检查:
${list(data.summary)}

状态:
已移动到 \`${statuses.needsClarification}\`。`
  }
  if (data.result === "BLOCKED") {
    return `Codex Implementation Blocked

原因:
${list(data.blockerOrQuestions)}

已检查:
${list(data.summary)}

测试:
${tests(data.testsRun)}

状态:
已移动到 \`${statuses.blocked}\`。`
  }
  return `Codex Implementation Failed

失败原因:
${list(data.blockerOrQuestions.length ? data.blockerOrQuestions : data.summary)}

变更文件:
${list(data.changedFiles)}

测试:
${tests(data.testsRun)}

提交:
${data.commit || "无"}

下一步需要:
- 查看失败详情，并决定是重试、补充说明，还是拆分 issue。`
}

export function hasRecentMarker(issue, prefixes) {
  const marker = latestMarker(issue, prefixes)
  if (!marker) {
    return false
  }
  return new Date(marker.createdAt).getTime() >= new Date(issue.updatedAt).getTime()
}

export function latestMarker(issue, prefixes) {
  return [...(issue.comments || [])]
    .reverse()
    .find((comment) => prefixes.some((prefix) => comment.body?.startsWith(prefix)))
}

function normalizeResult(result) {
  return {
    result: String(result?.result || "").trim(),
    summary: toArray(result?.summary),
    implementationPlan: toArray(result?.implementationPlan),
    acceptanceCriteria: toArray(result?.acceptanceCriteria),
    likelyFiles: toArray(result?.likelyFiles),
    suggestedTests: toArray(result?.suggestedTests),
    risks: toArray(result?.risks),
    questions: toArray(result?.questions),
    blockedReason: toArray(result?.blockedReason),
    relatedIssues: toArray(result?.relatedIssues),
    plannedCommitMessage: String(result?.plannedCommitMessage || ""),
    changedFiles: toArray(result?.changedFiles),
    testsRun: Array.isArray(result?.testsRun) ? result.testsRun : [],
    manualVerification: toArray(result?.manualVerification),
    commit: String(result?.commit || ""),
    diffReview: toArray(result?.diffReview),
    blockerOrQuestions: toArray(result?.blockerOrQuestions),
    risksOrNotes: toArray(result?.risksOrNotes),
  }
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean)
  }
  if (value == null || value === "") {
    return []
  }
  return [String(value)]
}

function list(items) {
  const values = toArray(items)
  return values.length ? values.map((item) => `- ${item}`).join("\n") : "- 无"
}

function numbered(items) {
  const values = toArray(items)
  return values.length ? values.map((item, index) => `${index + 1}. ${item}`).join("\n") : "1. 无"
}

function tests(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "- 未运行"
  }
  return items
    .map((item) => {
      if (typeof item === "string") {
        return `- ${item}`
      }
      return `- ${item.command || "未知命令"}: ${item.status || "not run"} - ${item.note || ""}`
    })
    .join("\n")
}
