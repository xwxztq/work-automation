import {
  ISSUE_PLATFORM_ERROR_CODE,
  ISSUE_PLATFORM_OPERATION,
  IssuePlatformError,
} from "./issue-platform.mjs"
import { LINEAR_ISSUE_PLATFORM } from "./linear-read-adapter.mjs"

const COMMENT_CREATE_MUTATION = `
  mutation LinearWriteCommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body createdAt updatedAt archivedAt }
    }
  }
`

const ISSUE_STATE_UPDATE_MUTATION = `
  mutation LinearWriteIssueStateUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id state { id name type archivedAt } }
    }
  }
`

export const LINEAR_WRITE_SUPPORTED_OPERATIONS = Object.freeze([
  ISSUE_PLATFORM_OPERATION.CREATE_COMMENT,
  ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE,
])

export function createLinearWriteAdapter(linearClient) {
  if (!linearClient || typeof linearClient.graphql !== "function") {
    throw new TypeError("Linear 写入适配器需要 graphql 客户端。")
  }

  async function createComment(request, { commentId } = {}) {
    validateRequest(request, ISSUE_PLATFORM_OPERATION.CREATE_COMMENT)
    const normalizedCommentId = requireValue(commentId, "$.idempotencyKey")
    try {
      const data = await linearClient.graphql(COMMENT_CREATE_MUTATION, {
        input: {
          id: normalizedCommentId,
          issueId: request.target.issueId,
          body: request.payload.body,
        },
      })
      if (!data?.commentCreate?.success || !data.commentCreate.comment) {
        throw new IssuePlatformError({
          code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
          operation: ISSUE_PLATFORM_OPERATION.CREATE_COMMENT,
        })
      }
      return normalizeComment(data.commentCreate.comment)
    } catch (error) {
      throw classifyLinearWriteError(error, ISSUE_PLATFORM_OPERATION.CREATE_COMMENT)
    }
  }

  async function updateIssueState(request, { stateId } = {}) {
    validateRequest(request, ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE)
    const normalizedStateId = requireValue(stateId, "$.payload.state")
    try {
      const data = await linearClient.graphql(ISSUE_STATE_UPDATE_MUTATION, {
        id: request.target.issueId,
        input: { stateId: normalizedStateId },
      })
      if (!data?.issueUpdate?.success || !data.issueUpdate.issue?.state) {
        throw new IssuePlatformError({
          code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
          operation: ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE,
        })
      }
      return normalizeState(data.issueUpdate.issue.state)
    } catch (error) {
      throw classifyLinearWriteError(
        error,
        ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE,
      )
    }
  }

  return Object.freeze({
    platform: LINEAR_ISSUE_PLATFORM,
    supportedOperations: LINEAR_WRITE_SUPPORTED_OPERATIONS,
    createComment,
    updateIssueState,
  })
}

function validateRequest(request, operation) {
  if (
    !request ||
    request.target?.platform !== LINEAR_ISSUE_PLATFORM ||
    !String(request.target?.issueId || "").trim() ||
    !String(request.idempotencyKey || "").trim() ||
    !request.payload
  ) {
    throw new IssuePlatformError({
      code: ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
      operation,
    })
  }
}

function requireValue(value, path) {
  const normalized = String(value || "").trim()
  if (!normalized) {
    throw new IssuePlatformError({
      code: ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
      path,
    })
  }
  return normalized
}

function normalizeComment(comment) {
  return {
    id: comment.id,
    body: comment.body || "",
    createdAt: comment.createdAt || null,
    updatedAt: comment.updatedAt || null,
    archivedAt: comment.archivedAt || null,
  }
}

function normalizeState(state) {
  return {
    id: state.id,
    name: state.name || "",
    type: state.type || "",
    archivedAt: state.archivedAt || null,
  }
}

function classifyLinearWriteError(error, operation) {
  if (error instanceof IssuePlatformError) {
    return error
  }
  const message = String(error?.message || "").toLowerCase()
  const messageStatus = Number(/linear http (\d{3})/u.exec(message)?.[1] || 0)
  const status = Number(
    error?.status ||
    error?.statusCode ||
    error?.extensions?.http?.status ||
    error?.cause?.status ||
    messageStatus,
  )
  const providerCode = String(error?.code || error?.cause?.code || "").toUpperCase()

  if (/archived|已归档/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.ARCHIVED, operation)
  }
  if (status === 401 || status === 403 || /unauth|forbidden|permission denied|access denied/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.PERMISSION_DENIED, operation)
  }
  if (status === 404 || /(?:entity |resource )?not found|未找到/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND, operation)
  }
  if (status === 409 || /conflict|already exists|duplicate/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.CONFLICT, operation)
  }
  if (status === 429 || /rate.?limit|too many requests/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.RATE_LIMITED, operation, true)
  }
  if (
    status >= 500 ||
    ["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT"].includes(providerCode) ||
    /network|socket|timed? ?out|请求超时|请求失败/u.test(message)
  ) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.UNAVAILABLE, operation, true)
  }
  return new IssuePlatformError({
    code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    operation,
  })
}

function platformError(code, operation, retryable = false) {
  return new IssuePlatformError({ code, operation, retryable })
}
