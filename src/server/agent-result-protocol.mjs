import {
  ISSUE_PLATFORM_OPERATION,
  ISSUE_PLATFORM_OPERATIONS,
  isIssuePlatformId,
} from "./issue-platform.mjs"

export const AGENT_RESULT_SCHEMA_VERSION = "1"
export const AGENT_RESULT_STAGES = Object.freeze(["part1", "split", "part2", "part3"])
export const AGENT_RESULT_OPERATION = ISSUE_PLATFORM_OPERATION

export const AGENT_RESULT_ERROR_CODE = Object.freeze({
  INVALID_JSON: "INVALID_JSON",
  INVALID_CONTEXT: "INVALID_CONTEXT",
  MISSING_FIELD: "MISSING_FIELD",
  INVALID_FIELD: "INVALID_FIELD",
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
  UNKNOWN_VERSION: "UNKNOWN_VERSION",
  UNKNOWN_STAGE: "UNKNOWN_STAGE",
  STAGE_MISMATCH: "STAGE_MISMATCH",
  PROJECT_MISMATCH: "PROJECT_MISMATCH",
  PARENT_ISSUE_MISMATCH: "PARENT_ISSUE_MISMATCH",
  TARGET_MISMATCH: "TARGET_MISMATCH",
  UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
  OPERATION_NOT_ALLOWED: "OPERATION_NOT_ALLOWED",
  DUPLICATE_OPERATION: "DUPLICATE_OPERATION",
  INVALID_IDEMPOTENCY_KEY: "INVALID_IDEMPOTENCY_KEY",
  DUPLICATE_IDEMPOTENCY_KEY: "DUPLICATE_IDEMPOTENCY_KEY",
})

export const AGENT_RESULT_ERROR_CODES = Object.freeze(
  Object.values(AGENT_RESULT_ERROR_CODE),
)

export const ISSUE_READ_INCLUDE = Object.freeze(["comments", "attachments", "relations"])

const STAGE_SET = new Set(AGENT_RESULT_STAGES)
const OPERATION_SET = new Set(ISSUE_PLATFORM_OPERATIONS)
const READ_INCLUDE_SET = new Set(ISSUE_READ_INCLUDE)
const IDEMPOTENCY_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{7,127}$/iu
const MAX_EXTENSION_DEPTH = 32

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "run",
  "target",
  "operations",
  "extensions",
])
const RUN_FIELDS = new Set([
  "stage",
  "projectKey",
  "parentIssueId",
  "allowedOperations",
  "extensions",
])
const TARGET_FIELDS = new Set(["platform", "issueId", "extensions"])
const OPERATION_FIELDS = new Set(["type", "idempotencyKey", "payload", "extensions"])

/**
 * Parse the exact JSON document written by Codex. Markdown fences and surrounding
 * prose are intentionally rejected so callers never infer operations from free text.
 */
export function parseAgentResult(text, context) {
  if (typeof text !== "string" || !text.trim()) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_JSON,
      "$",
      "Agent 结果不是有效 JSON。",
    )
  }

  let value
  try {
    value = JSON.parse(text)
  } catch {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_JSON,
      "$",
      "Agent 结果不是有效 JSON。",
    )
  }

  return validateAgentResult(value, context)
}

/**
 * Validate and normalize an already parsed Agent result against the immutable run
 * context supplied by the service.
 */
export function validateAgentResult(value, context) {
  const normalizedContext = normalizeContext(context)
  if (!normalizedContext.ok) {
    return normalizedContext
  }
  return normalizeEnvelope(value, normalizedContext.value)
}

function normalizeContext(context) {
  if (!isRecord(context)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_CONTEXT,
      "context",
      "运行校验上下文不合法。",
    )
  }

  for (const field of ["stage", "projectKey", "parentIssueId", "target", "allowedOperations"]) {
    if (!hasOwn(context, field)) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.INVALID_CONTEXT,
        "context." + field,
        "运行校验上下文缺少必填字段。",
      )
    }
  }

  if (typeof context.stage !== "string" || !STAGE_SET.has(context.stage)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_CONTEXT,
      "context.stage",
      "运行校验上下文包含未知阶段。",
    )
  }
  if (!isNonEmptyString(context.projectKey)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_CONTEXT,
      "context.projectKey",
      "运行校验上下文的项目标识不合法。",
    )
  }
  if (!isNullableNonEmptyString(context.parentIssueId)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_CONTEXT,
      "context.parentIssueId",
      "运行校验上下文的父事项标识不合法。",
    )
  }

  const target = normalizeTargetValue(context.target, "context.target")
  if (!target.ok) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_CONTEXT,
      target.error.path,
      "运行校验上下文的目标不合法。",
    )
  }
  const allowedOperations = normalizeAllowedOperations(
    context.allowedOperations,
    "context.allowedOperations",
  )
  if (!allowedOperations.ok) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_CONTEXT,
      allowedOperations.error.path,
      "运行校验上下文的操作权限不合法。",
    )
  }

  return valid({
    stage: context.stage,
    projectKey: context.projectKey.trim(),
    parentIssueId:
      typeof context.parentIssueId === "string" ? context.parentIssueId.trim() : null,
    target: target.value,
    allowedOperations: allowedOperations.value,
    allowedOperationSet: new Set(allowedOperations.value),
  })
}

function normalizeEnvelope(value, context) {
  if (!isRecord(value)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      "$",
      "Agent 结果必须是 JSON 对象。",
    )
  }

  for (const field of ["schemaVersion", "run", "target", "operations"]) {
    if (!hasOwn(value, field)) {
      return missing("$." + field)
    }
  }
  const unknownRootField = findUnknownField(value, ROOT_FIELDS, "$")
  if (unknownRootField) return unknownRootField

  if (value.schemaVersion !== AGENT_RESULT_SCHEMA_VERSION) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.UNKNOWN_VERSION,
      "$.schemaVersion",
      "Agent 结果使用了不受支持的 schema 版本。",
    )
  }

  const run = normalizeRun(value.run, context)
  if (!run.ok) return run
  const target = normalizeTarget(value.target, context.target)
  if (!target.ok) return target
  const operations = normalizeOperations(
    value.operations,
    new Set(run.value.allowedOperations),
    context.allowedOperationSet,
  )
  if (!operations.ok) return operations
  const extensions = normalizeOptionalExtensions(value, "extensions", "$.extensions")
  if (!extensions.ok) return extensions

  return valid({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    run: run.value,
    target: target.value,
    operations: operations.value,
    ...(extensions.present ? { extensions: extensions.value } : {}),
  })
}

function normalizeRun(value, context) {
  if (!isRecord(value)) {
    return invalid(AGENT_RESULT_ERROR_CODE.INVALID_FIELD, "$.run", "run 必须是对象。")
  }
  for (const field of ["stage", "projectKey", "parentIssueId", "allowedOperations"]) {
    if (!hasOwn(value, field)) return missing("$.run." + field)
  }
  const unknownField = findUnknownField(value, RUN_FIELDS, "$.run")
  if (unknownField) return unknownField

  if (typeof value.stage !== "string" || !STAGE_SET.has(value.stage)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.UNKNOWN_STAGE,
      "$.run.stage",
      "Agent 结果包含未知运行阶段。",
    )
  }
  if (value.stage !== context.stage) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.STAGE_MISMATCH,
      "$.run.stage",
      "Agent 结果的运行阶段与本次任务不一致。",
    )
  }
  if (!isNonEmptyString(value.projectKey)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      "$.run.projectKey",
      "项目标识不合法。",
    )
  }
  if (value.projectKey.trim() !== context.projectKey) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.PROJECT_MISMATCH,
      "$.run.projectKey",
      "Agent 结果的项目与本次任务不一致。",
    )
  }
  if (!isNullableNonEmptyString(value.parentIssueId)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      "$.run.parentIssueId",
      "父事项标识不合法。",
    )
  }
  const parentIssueId =
    typeof value.parentIssueId === "string" ? value.parentIssueId.trim() : null
  if (parentIssueId !== context.parentIssueId) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.PARENT_ISSUE_MISMATCH,
      "$.run.parentIssueId",
      "Agent 结果的父事项与本次任务不一致。",
    )
  }

  const allowedOperations = normalizeAllowedOperations(
    value.allowedOperations,
    "$.run.allowedOperations",
    context.allowedOperationSet,
  )
  if (!allowedOperations.ok) return allowedOperations
  const extensions = normalizeOptionalExtensions(value, "extensions", "$.run.extensions")
  if (!extensions.ok) return extensions

  return valid({
    stage: value.stage,
    projectKey: value.projectKey.trim(),
    parentIssueId,
    allowedOperations: allowedOperations.value,
    ...(extensions.present ? { extensions: extensions.value } : {}),
  })
}

function normalizeTarget(value, expectedTarget) {
  const target = normalizeTargetValue(value, "$.target")
  if (!target.ok) return target
  if (
    target.value.platform !== expectedTarget.platform ||
    target.value.issueId !== expectedTarget.issueId
  ) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.TARGET_MISMATCH,
      "$.target",
      "Agent 结果的目标与本次任务不一致。",
    )
  }
  return target
}

function normalizeTargetValue(value, path) {
  if (!isRecord(value)) {
    return invalid(AGENT_RESULT_ERROR_CODE.INVALID_FIELD, path, "目标必须是对象。")
  }
  for (const field of ["platform", "issueId"]) {
    if (!hasOwn(value, field)) return missing(path + "." + field)
  }
  const unknownField = findUnknownField(value, TARGET_FIELDS, path)
  if (unknownField) return unknownField
  if (!isIssuePlatformId(value.platform)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".platform",
      "平台标识不合法。",
    )
  }
  if (!isNonEmptyString(value.issueId)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".issueId",
      "事项标识不合法。",
    )
  }
  const extensions = normalizeOptionalExtensions(value, "extensions", path + ".extensions")
  if (!extensions.ok) return extensions
  return valid({
    platform: value.platform.trim(),
    issueId: value.issueId.trim(),
    ...(extensions.present ? { extensions: extensions.value } : {}),
  })
}

function normalizeAllowedOperations(value, path, grantedOperationSet = null) {
  if (!Array.isArray(value)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "允许操作必须是数组。",
    )
  }
  const seen = new Set()
  const normalized = []
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = path + "[" + index + "]"
    const operation = value[index]
    if (typeof operation !== "string" || !OPERATION_SET.has(operation)) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.UNKNOWN_OPERATION,
        itemPath,
        "允许操作包含未知类型。",
      )
    }
    if (seen.has(operation)) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.DUPLICATE_OPERATION,
        itemPath,
        "允许操作不能重复。",
      )
    }
    if (grantedOperationSet && !grantedOperationSet.has(operation)) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.OPERATION_NOT_ALLOWED,
        itemPath,
        "Agent 声明了本次任务未授权的操作。",
      )
    }
    seen.add(operation)
    normalized.push(operation)
  }
  return valid(normalized)
}

function normalizeOperations(value, declaredOperationSet, grantedOperationSet) {
  if (!Array.isArray(value)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      "$.operations",
      "operations 必须是数组。",
    )
  }

  const idempotencyKeys = new Set()
  const normalized = []
  for (let index = 0; index < value.length; index += 1) {
    const result = normalizeOperation(
      value[index],
      index,
      declaredOperationSet,
      grantedOperationSet,
      idempotencyKeys,
    )
    if (!result.ok) return result
    normalized.push(result.value)
  }
  return valid(normalized)
}

function normalizeOperation(
  value,
  index,
  declaredOperationSet,
  grantedOperationSet,
  idempotencyKeys,
) {
  const path = "$.operations[" + index + "]"
  if (!isRecord(value)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "操作必须是对象。",
    )
  }
  for (const field of ["type", "idempotencyKey", "payload"]) {
    if (!hasOwn(value, field)) return missing(path + "." + field)
  }
  const unknownField = findUnknownField(value, OPERATION_FIELDS, path)
  if (unknownField) return unknownField

  if (typeof value.type !== "string" || !OPERATION_SET.has(value.type)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.UNKNOWN_OPERATION,
      path + ".type",
      "操作类型不受支持。",
    )
  }
  if (!grantedOperationSet.has(value.type) || !declaredOperationSet.has(value.type)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.OPERATION_NOT_ALLOWED,
      path + ".type",
      "操作未同时获得服务授权和结果声明授权。",
    )
  }
  if (
    typeof value.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)
  ) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_IDEMPOTENCY_KEY,
      path + ".idempotencyKey",
      "幂等键格式不合法。",
    )
  }
  if (idempotencyKeys.has(value.idempotencyKey)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.DUPLICATE_IDEMPOTENCY_KEY,
      path + ".idempotencyKey",
      "同一结果内的幂等键不能重复。",
    )
  }
  idempotencyKeys.add(value.idempotencyKey)

  const payload = normalizePayload(value.type, value.payload, path + ".payload")
  if (!payload.ok) return payload
  const extensions = normalizeOptionalExtensions(value, "extensions", path + ".extensions")
  if (!extensions.ok) return extensions

  return valid({
    type: value.type,
    idempotencyKey: value.idempotencyKey,
    payload: payload.value,
    ...(extensions.present ? { extensions: extensions.value } : {}),
  })
}

function normalizePayload(operation, value, path) {
  if (!isRecord(value)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "操作 payload 必须是对象。",
    )
  }

  if (operation === ISSUE_PLATFORM_OPERATION.READ_ISSUE) {
    return normalizeReadPayload(value, path)
  }
  if (operation === ISSUE_PLATFORM_OPERATION.CREATE_COMMENT) {
    return normalizeCommentPayload(value, path)
  }
  if (operation === ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE) {
    return normalizeStatePayload(value, path)
  }
  if (operation === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE) {
    return normalizeChildPayload(value, path)
  }
  return normalizeAttachmentPayload(value, path)
}

function normalizeReadPayload(value, path) {
  const unknownField = findUnknownField(value, new Set(["include", "extensions"]), path)
  if (unknownField) return unknownField
  const include = hasOwn(value, "include") ? value.include : []
  if (!Array.isArray(include)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".include",
      "读取选项必须是数组。",
    )
  }
  const seen = new Set()
  for (let index = 0; index < include.length; index += 1) {
    if (typeof include[index] !== "string" || !READ_INCLUDE_SET.has(include[index])) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
        path + ".include[" + index + "]",
        "读取选项不受支持。",
      )
    }
    if (seen.has(include[index])) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
        path + ".include[" + index + "]",
        "读取选项不能重复。",
      )
    }
    seen.add(include[index])
  }
  return withPayloadExtensions(value, path, { include: [...include] })
}

function normalizeCommentPayload(value, path) {
  const unknownField = findUnknownField(value, new Set(["body", "extensions"]), path)
  if (unknownField) return unknownField
  if (!hasOwn(value, "body")) return missing(path + ".body")
  if (typeof value.body !== "string" || !value.body.trim()) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".body",
      "评论正文不能为空。",
    )
  }
  return withPayloadExtensions(value, path, { body: value.body })
}

function normalizeStatePayload(value, path) {
  const unknownField = findUnknownField(value, new Set(["state", "extensions"]), path)
  if (unknownField) return unknownField
  if (!hasOwn(value, "state")) return missing(path + ".state")
  if (!isNonEmptyString(value.state)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".state",
      "目标状态不能为空。",
    )
  }
  return withPayloadExtensions(value, path, { state: value.state.trim() })
}

function normalizeChildPayload(value, path) {
  const unknownField = findUnknownField(
    value,
    new Set(["title", "description", "extensions"]),
    path,
  )
  if (unknownField) return unknownField
  if (!hasOwn(value, "title")) return missing(path + ".title")
  if (!isNonEmptyString(value.title)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".title",
      "子事项标题不能为空。",
    )
  }
  if (hasOwn(value, "description") && typeof value.description !== "string") {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".description",
      "子事项描述必须是字符串。",
    )
  }
  return withPayloadExtensions(value, path, {
    title: value.title.trim(),
    ...(hasOwn(value, "description") ? { description: value.description } : {}),
  })
}

function normalizeAttachmentPayload(value, path) {
  const fields = new Set(["filePath", "filename", "contentType", "title", "extensions"])
  const unknownField = findUnknownField(value, fields, path)
  if (unknownField) return unknownField
  if (!hasOwn(value, "filePath")) return missing(path + ".filePath")
  if (!isNonEmptyString(value.filePath)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path + ".filePath",
      "附件路径不能为空。",
    )
  }
  const normalized = { filePath: value.filePath.trim() }
  for (const field of ["filename", "contentType", "title"]) {
    if (!hasOwn(value, field)) continue
    if (!isNonEmptyString(value[field])) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
        path + "." + field,
        "附件字段必须是非空字符串。",
      )
    }
    normalized[field] = value[field].trim()
  }
  return withPayloadExtensions(value, path, normalized)
}

function withPayloadExtensions(value, path, normalized) {
  const extensions = normalizeOptionalExtensions(value, "extensions", path + ".extensions")
  if (!extensions.ok) return extensions
  return valid({
    ...normalized,
    ...(extensions.present ? { extensions: extensions.value } : {}),
  })
}

function normalizeOptionalExtensions(owner, field, path) {
  if (!hasOwn(owner, field)) {
    return { ok: true, present: false, value: undefined }
  }
  const normalized = normalizeJsonValue(owner[field], path, new WeakSet(), 0)
  if (!normalized.ok) return normalized
  if (!isRecord(normalized.value)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "extensions 必须是 JSON 对象。",
    )
  }
  return { ok: true, present: true, value: normalized.value }
}

function normalizeJsonValue(value, path, ancestors, depth) {
  if (depth > MAX_EXTENSION_DEPTH) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "扩展数据嵌套过深。",
    )
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return valid(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return valid(value)
  }
  if (typeof value !== "object" || value === null) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "扩展数据必须是 JSON 值。",
    )
  }
  if (ancestors.has(value)) {
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "扩展数据不能循环引用。",
    )
  }
  ancestors.add(value)

  if (Array.isArray(value)) {
    const normalized = []
    for (let index = 0; index < value.length; index += 1) {
      const item = normalizeJsonValue(
        value[index],
        path + "[" + index + "]",
        ancestors,
        depth + 1,
      )
      if (!item.ok) return item
      normalized.push(item.value)
    }
    ancestors.delete(value)
    return valid(normalized)
  }
  if (!isRecord(value)) {
    ancestors.delete(value)
    return invalid(
      AGENT_RESULT_ERROR_CODE.INVALID_FIELD,
      path,
      "扩展数据必须是普通 JSON 对象。",
    )
  }

  const entries = []
  for (const [key, itemValue] of Object.entries(value)) {
    const item = normalizeJsonValue(itemValue, appendPath(path, key), ancestors, depth + 1)
    if (!item.ok) return item
    entries.push([key, item.value])
  }
  ancestors.delete(value)
  return valid(Object.fromEntries(entries))
}

function findUnknownField(value, allowedFields, path) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      return invalid(
        AGENT_RESULT_ERROR_CODE.UNKNOWN_FIELD,
        appendPath(path, field),
        "字段不属于当前协议版本。",
      )
    }
  }
  return null
}

function appendPath(path, field) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(field)
    ? path + "." + field
    : path + "[" + JSON.stringify(field) + "]"
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim())
}

function isNullableNonEmptyString(value) {
  return value === null || isNonEmptyString(value)
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field)
}

function missing(path) {
  return invalid(
    AGENT_RESULT_ERROR_CODE.MISSING_FIELD,
    path,
    "缺少协议必填字段。",
  )
}

function valid(value) {
  return { ok: true, value }
}

function invalid(code, path, message) {
  return {
    ok: false,
    error: {
      code,
      path,
      message,
      retryable: false,
    },
  }
}
