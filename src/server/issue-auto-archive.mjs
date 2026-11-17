import { recordIssueAudit, withIssueAuditContext } from "./issue-audit.mjs"

const DAY_MS = 24 * 60 * 60 * 1000
const TERMINAL_TYPES = new Set(["completed", "canceled"])

export function enteredTerminalStateAt(issue, history) {
  if (!issue?.state?.id || !TERMINAL_TYPES.has(issue.state.type)) return null
  const times = [issue.createdAt, issue.state.type === "completed" ? issue.completedAt : issue.canceledAt]
    .filter(Boolean).map(Date.parse)
  let latestChange = null
  for (const entry of history) {
    if (!entry.fromStateId && !entry.toStateId) continue
    // Linear can group closely spaced updates. Use the end of the recorded
    // change so a transition recorded in that group never ages prematurely.
    const time = Math.max(Date.parse(entry.createdAt), Date.parse(entry.updatedAt || entry.createdAt))
    if (!Number.isFinite(time)) return null
    if (!latestChange || time > latestChange.time) latestChange = { time, stateId: entry.toStateId }
    else if (time === latestChange.time && entry.toStateId !== latestChange.stateId) return null
  }
  if (latestChange && latestChange.stateId !== issue.state.id) return null
  // An issue can be created directly in a terminal state. Without a state
  // transition record, only the unchanged snapshot proves a continuous period.
  const since = Math.max(...times, latestChange?.time ?? Date.parse(issue.updatedAt))
  return Number.isFinite(since) ? since : null
}

export async function autoArchiveProject({ project, linear, store, logEvent, isCurrent, isBusy, archiving, now = Date.now() }) {
  const { linearProjectId: projectId, key: projectKey, autoArchive } = project
  const cutoff = now - autoArchive.days * DAY_MS
  if (cutoff < -8.64e15) return
  const auditContext = { stage: "archive", projectId, projectKey }
  await withIssueAuditContext(auditContext, async () => {
    const candidates = await linear.listArchiveCandidates(projectId, new Date(cutoff).toISOString())
    for (const candidate of candidates) {
      if (!await isCurrent()) return
      if (archiving.has(candidate.id) || await isBusy(candidate.id) || archiving.has(candidate.id)) continue
      archiving.add(candidate.id)
      await withIssueAuditContext({ issueId: candidate.id }, async () => {
        try {
          const { issue, history } = await linear.readArchiveHistory(candidate.id)
          if (!canArchive(issue, candidate.id, projectId)) return
          const since = enteredTerminalStateAt(issue, history)
          if (since === null || since > cutoff) return
          const fresh = await linear.readArchiveState(candidate.id)
          if (!canArchive(fresh, candidate.id, projectId) || fresh.state.id !== issue.state.id ||
            fresh.updatedAt !== issue.updatedAt || fresh.completedAt !== issue.completedAt ||
            fresh.canceledAt !== issue.canceledAt || !await isCurrent() || await isBusy(candidate.id)) return
          let archived
          try {
            archived = await linear.operationWriter.archiveIssue(candidate.id)
          } catch (error) {
            archived = await linear.readArchiveState(candidate.id).catch(() => null)
            if (!archived?.archivedAt) throw error
          }
          if (!archived?.archivedAt) archived = await linear.readArchiveState(candidate.id)
          if (archived?.id !== candidate.id || !archived.archivedAt) throw new Error("Linear 回读未确认事项已归档。")
          await recordIssueAudit(store, { operation: "issue.archive", result: "verified", resourceId: candidate.id })
          await logEvent({ ...auditContext, type: "issue-auto-archived", issueIdentifier: candidate.identifier,
            message: `${candidate.identifier} 连续处于终态已满 ${autoArchive.days} 天，已归档。` })
        } catch (error) {
          await logEvent({ ...auditContext, type: "issue-auto-archive-error", level: "error", issueIdentifier: candidate.identifier,
            message: error.message })
        } finally {
          archiving.delete(candidate.id)
        }
      })
    }
  })
}

function canArchive(issue, id, projectId) {
  // Linear archives descendants with the parent. Process unarchived leaves
  // independently so a parent cannot archive an ineligible child by proxy.
  return issue?.id === id && issue.project?.id === projectId && !issue.archivedAt &&
    Boolean(issue.state?.id && issue.updatedAt) && TERMINAL_TYPES.has(issue.state.type) &&
    issue.children?.nodes?.length === 0 && issue.children.pageInfo?.hasNextPage === false
}
