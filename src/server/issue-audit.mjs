import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { normalizeIssuePlatformError } from "./issue-platform.mjs"

const context = new AsyncLocalStorage()
const wrapped = new WeakSet()
const methods = {
  readIssue: "issue.read", getIssue: "issue.read", readProject: "project.read",
  listProjects: "project.list", listProjectIssues: "issue.list",
  listTeamWorkflowStates: "workflow.read", listProjectWorkflowStates: "workflow.read",
  listProjectsWorkflowStates: "workflow.read",
  createComment: "comment.create", updateIssueState: "issue.state.update",
  createChildIssue: "issue.child.create", verifyCommentImages: "comment.images.read",
}

export function withIssueAuditContext(fields, task) {
  return context.run({ ...context.getStore(), ...fields }, task)
}

export function bindIssueAuditRun(run) {
  const active = context.getStore()
  if (active) Object.assign(active, { runId: run.id, platform: run.issueBinding?.platform })
}

export function failureCategory(error, fallback = "provider") {
  return ["INVALID_REQUEST", "CONFLICT", "ARCHIVED", "NOT_FOUND"].includes(error?.code)
    ? "service-validation" : fallback
}

// Record only metadata: never provider bodies, operation payloads, headers or URLs.
export async function recordIssueAudit(store, fields) {
  if (!store?.appendIssueAudit) return
  await store.appendIssueAudit({ ...context.getStore(), ...fields })
}

export function auditIssueAdapter(adapter, store, defaults = {}) {
  if (!adapter || wrapped.has(adapter)) return adapter
  const result = { ...adapter }
  for (const [method, operation] of Object.entries(methods)) {
    if (typeof adapter[method] !== "function") continue
    result[method] = async (...args) => {
      const request = args[0]
      const isWrite = ["createComment", "updateIssueState", "createChildIssue"].includes(method)
      const active = { ...defaults, ...context.getStore() }
      const projectId = method.includes("Project") && typeof request === "string" ? request : active.projectId
      const projectKey = defaults.projects?.find((p) => p.linearProjectId === projectId)?.key || active.projectKey
      const fields = {
        ...active, projectKey, projectId,
        platform: adapter.platform || active.platform || "primary-issues",
        issueId: request?.target?.issueId || (method === "readIssue" || method === "getIssue" ? request : active.issueId),
        operation,
        idempotencyKey: request?.idempotencyKey || request?.operation?.idempotencyKey || active.idempotencyKey || `read:${method}:${createHash("sha256").update(JSON.stringify(typeof request === "string" || Array.isArray(request) ? request : null)).digest("hex").slice(0, 20)}`,
        attemptId: randomUUID(),
      }
      await recordIssueAudit(store, { ...fields, result: "started" })
      let value
      try {
        value = await adapter[method](...args)
      } catch (error) {
        const normalized = normalizeIssuePlatformError(error)
        await recordIssueAudit(store, { ...fields, result: "failed", errorCode: normalized.code, failureCategory: "provider", retryable: normalized.retryable })
        throw error
      }
      const incomplete = value?.complete === false
      const failures = Array.isArray(value) ? value.filter((item) => item?.error) : []
      await recordIssueAudit(store, {
        ...fields, result: incomplete || failures.length ? "failed" : "succeeded",
        errorCode: incomplete ? "PAGINATION_INTERRUPTED" : failures[0]?.error?.code,
        failureCategory: incomplete || failures.length ? "provider" : null,
        retryable: incomplete || failures.some((item) => item.error.retryable),
        resourceId: isWrite ? value?.id : null,
      })
      return value
    }
  }
  if (adapter.operationWriter) result.operationWriter = auditIssueAdapter(adapter.operationWriter, store, defaults)
  wrapped.add(result)
  return result
}
