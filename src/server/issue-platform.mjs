export const ISSUE_PLATFORM_OPERATION = Object.freeze({
  READ_ISSUE: "issue.read",
  CREATE_COMMENT: "comment.create",
  UPDATE_ISSUE_STATE: "issue.state.update",
  CREATE_CHILD_ISSUE: "issue.child.create",
  UPLOAD_ATTACHMENT: "attachment.upload",
})

export const ISSUE_PLATFORM_OPERATIONS = Object.freeze(
  Object.values(ISSUE_PLATFORM_OPERATION),
)

export const ISSUE_PLATFORM_METHOD_BY_OPERATION = Object.freeze({
  [ISSUE_PLATFORM_OPERATION.READ_ISSUE]: "readIssue",
  [ISSUE_PLATFORM_OPERATION.CREATE_COMMENT]: "createComment",
  [ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE]: "updateIssueState",
  [ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE]: "createChildIssue",
  [ISSUE_PLATFORM_OPERATION.UPLOAD_ATTACHMENT]: "uploadAttachment",
})

export const ISSUE_PLATFORM_ERROR_CODE = Object.freeze({
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  UNAVAILABLE: "UNAVAILABLE",
  OPERATION_FAILED: "OPERATION_FAILED",
})

export const ISSUE_PLATFORM_ERROR_CODES = Object.freeze(
  Object.values(ISSUE_PLATFORM_ERROR_CODE),
)

const PLATFORM_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u
const ERROR_CODE_SET = new Set(ISSUE_PLATFORM_ERROR_CODES)
const OPERATION_SET = new Set(ISSUE_PLATFORM_OPERATIONS)
const ERROR_MESSAGE_BY_CODE = Object.freeze({
  [ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST]: "事项平台请求不合法。",
  [ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND]: "事项平台目标不存在。",
  [ISSUE_PLATFORM_ERROR_CODE.PERMISSION_DENIED]: "当前身份不能执行该事项平台操作。",
  [ISSUE_PLATFORM_ERROR_CODE.CONFLICT]: "事项平台操作发生冲突。",
  [ISSUE_PLATFORM_ERROR_CODE.RATE_LIMITED]: "事项平台请求受到速率限制。",
  [ISSUE_PLATFORM_ERROR_CODE.UNAVAILABLE]: "事项平台暂时不可用。",
  [ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED]: "事项平台操作失败。",
})
const ERROR_PATH_PATTERNS = Object.freeze([
  /^\$$/u,
  /^\$\.target(?:\.(?:platform|issueId))?$/u,
  /^\$\.idempotencyKey$/u,
  /^\$\.payload$/u,
  /^\$\.payload\.(?:body|state|title|description|filePath|filename|contentType)$/u,
  /^\$\.payload\.include(?:\[\d+\])?$/u,
])

/**
 * @typedef {object} IssuePlatformTarget
 * @property {string} platform Adapter registry key, not a provider credential.
 * @property {string} issueId Opaque issue identifier interpreted by the adapter.
 */

/**
 * @typedef {object} IssuePlatformState
 * @property {string} name Platform-independent workflow state name.
 */

/**
 * @typedef {object} IssuePlatformComment
 * @property {string} id Opaque comment identifier.
 * @property {string} body Comment Markdown.
 * @property {string} createdAt ISO timestamp.
 */

/**
 * @typedef {object} IssuePlatformAttachment
 * @property {string} id Opaque attachment identifier.
 * @property {string} filename Display filename.
 * @property {string|null} url Platform URL, when available.
 */

/**
 * @typedef {object} IssuePlatformIssue
 * @property {string} id Opaque issue identifier.
 * @property {string} identifier Human-readable identifier, when available.
 * @property {string} title Issue title.
 * @property {string|null} description Issue Markdown, when available.
 * @property {IssuePlatformState} state Normalized workflow state.
 * @property {string|null} parentIssueId Opaque parent identifier.
 * @property {Array<{name: string}>} labels Normalized labels.
 * @property {IssuePlatformComment[]} comments Normalized comments when requested.
 * @property {IssuePlatformAttachment[]} attachments Normalized attachments when requested.
 */

/**
 * @typedef {object} IssuePlatformRequestBase
 * @property {IssuePlatformTarget} target
 * @property {string} idempotencyKey
 */

/**
 * @typedef {IssuePlatformRequestBase & {
 *   payload: {include: Array<"comments"|"attachments"|"relations">}
 * }} ReadIssueRequest
 */

/**
 * @typedef {IssuePlatformRequestBase & {
 *   payload: {body: string}
 * }} CreateCommentRequest
 */

/**
 * @typedef {IssuePlatformRequestBase & {
 *   payload: {state: string}
 * }} UpdateIssueStateRequest
 */

/**
 * @typedef {IssuePlatformRequestBase & {
 *   payload: {title: string, description?: string}
 * }} CreateChildIssueRequest
 */

/**
 * @typedef {IssuePlatformRequestBase & {
 *   payload: {
 *     filePath: string,
 *     filename?: string,
 *     contentType?: string,
 *     title?: string
 *   }
 * }} UploadAttachmentRequest
 */

/**
 * @typedef {object} IssuePlatformAdapter
 * @property {string} platform Stable adapter registry key.
 * @property {(request: ReadIssueRequest) => Promise<IssuePlatformIssue>} readIssue
 * @property {(request: CreateCommentRequest) => Promise<IssuePlatformComment>} createComment
 * @property {(request: UpdateIssueStateRequest) => Promise<IssuePlatformState>} updateIssueState
 * @property {(request: CreateChildIssueRequest) => Promise<IssuePlatformIssue>} createChildIssue
 * @property {(request: UploadAttachmentRequest) => Promise<IssuePlatformAttachment>} uploadAttachment
 */

/**
 * Validate and narrow a provider adapter to the platform-independent interface.
 * Provider clients, credentials, response objects, and status IDs stay captured inside
 * the bound methods and are not copied into the returned adapter surface.
 *
 * @param {IssuePlatformAdapter} adapter
 * @returns {Readonly<IssuePlatformAdapter>}
 */
export function defineIssuePlatform(adapter) {
  if (!isRecord(adapter) || !isIssuePlatformId(adapter.platform)) {
    throw new TypeError("事项平台适配器缺少合法的 platform 标识。")
  }

  const normalized = { platform: adapter.platform }
  for (const methodName of Object.values(ISSUE_PLATFORM_METHOD_BY_OPERATION)) {
    if (typeof adapter[methodName] !== "function") {
      throw new TypeError(`事项平台适配器缺少方法: ${methodName}`)
    }
    normalized[methodName] = adapter[methodName].bind(adapter)
  }

  return Object.freeze(normalized)
}

export function isIssuePlatformId(value) {
  return typeof value === "string" && PLATFORM_ID_PATTERN.test(value)
}

export class IssuePlatformError extends Error {
  constructor({
    code = ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    operation = null,
    path = "$",
    retryable = false,
  } = {}) {
    const normalizedCode = ERROR_CODE_SET.has(code)
      ? code
      : ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED
    super(ERROR_MESSAGE_BY_CODE[normalizedCode])
    this.name = "IssuePlatformError"
    this.code = normalizedCode
    this.operation = OPERATION_SET.has(operation) ? operation : null
    this.path = normalizeErrorPath(path)
    this.retryable = Boolean(retryable)
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      operation: this.operation,
      path: this.path,
      retryable: this.retryable,
    }
  }
}

/**
 * Convert adapter failures into the public error shape. Unknown provider errors use a
 * generic message so raw responses and credentials cannot cross the adapter boundary.
 */
export function normalizeIssuePlatformError(error, defaults = {}) {
  if (error instanceof IssuePlatformError) {
    return new IssuePlatformError({
      code: error.code,
      operation: error.operation || defaults.operation,
      path: error.path,
      retryable: error.retryable,
    }).toJSON()
  }

  return new IssuePlatformError({
    code: ERROR_CODE_SET.has(defaults.code)
      ? defaults.code
      : ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    operation: defaults.operation,
    path: defaults.path,
    retryable: defaults.retryable,
  }).toJSON()
}

function normalizeErrorPath(value) {
  if (typeof value !== "string") {
    return "$"
  }
  const path = value.trim()
  return path.length <= 256 && ERROR_PATH_PATTERNS.some((pattern) => pattern.test(path))
    ? path
    : "$"
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
