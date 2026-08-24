import {
  AGENT_RESULT_OPERATION,
  AGENT_RESULT_SCHEMA_VERSION,
  parseAgentResult,
  validateAgentResult,
} from "./agent-result-protocol.mjs"

export const AGENT_RESULT_PLATFORM = "primary-issues"

export const AGENT_RESULT_ALLOWED_OPERATIONS_BY_STAGE = Object.freeze({
  part1: Object.freeze([
    AGENT_RESULT_OPERATION.CREATE_COMMENT,
    AGENT_RESULT_OPERATION.UPDATE_ISSUE_STATE,
  ]),
  split: Object.freeze([
    AGENT_RESULT_OPERATION.CREATE_CHILD_ISSUE,
    AGENT_RESULT_OPERATION.CREATE_COMMENT,
    AGENT_RESULT_OPERATION.UPDATE_ISSUE_STATE,
  ]),
  part2: Object.freeze([
    AGENT_RESULT_OPERATION.CREATE_COMMENT,
    AGENT_RESULT_OPERATION.UPDATE_ISSUE_STATE,
  ]),
  part3: Object.freeze([
    AGENT_RESULT_OPERATION.UPLOAD_ATTACHMENT,
    AGENT_RESULT_OPERATION.CREATE_COMMENT,
    AGENT_RESULT_OPERATION.UPDATE_ISSUE_STATE,
  ]),
})

export function createAgentResultContext({ stage, projectKey, issue }) {
  const context = {
    stage,
    projectKey: String(projectKey || "").trim(),
    parentIssueId: resolveParentIssueId(issue),
    target: {
      platform: AGENT_RESULT_PLATFORM,
      issueId: String(issue?.id || "").trim(),
    },
    allowedOperations: [
      ...(AGENT_RESULT_ALLOWED_OPERATIONS_BY_STAGE[stage] || []),
    ],
  }
  const normalized = validateAgentResult(
    {
      schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
      run: {
        stage: context.stage,
        projectKey: context.projectKey,
        parentIssueId: context.parentIssueId,
        allowedOperations: context.allowedOperations,
      },
      target: context.target,
      operations: [],
    },
    context,
  )
  if (!normalized.ok) {
    throw new Error(formatAgentResultError(normalized.error))
  }
  return {
    stage: normalized.value.run.stage,
    projectKey: normalized.value.run.projectKey,
    parentIssueId: normalized.value.run.parentIssueId,
    target: normalized.value.target,
    allowedOperations: normalized.value.run.allowedOperations,
  }
}

export function evaluateAgentResult(finalText, context) {
  const result = parseAgentResult(finalText, context)
  if (result.ok) {
    return {
      ok: true,
      value: result.value,
    }
  }
  return {
    ok: false,
    error: result.error,
    diagnostic: formatAgentResultError(result.error),
  }
}

export function agentResultRunPatch(evaluation) {
  if (evaluation?.ok) {
    return {
      status: "succeeded",
      agentResult: evaluation.value,
      agentResultValidation: {
        ok: true,
        schemaVersion: evaluation.value.schemaVersion,
      },
      error: undefined,
      failureKind: undefined,
      failureSummary: undefined,
      failureAction: undefined,
      retryableFailure: undefined,
    }
  }
  const error = evaluation?.error || {
    code: "INVALID_CONTEXT",
    path: "context",
    message: "运行校验上下文不合法。",
    retryable: false,
  }
  return {
    status: "failed",
    agentResult: undefined,
    agentResultValidation: {
      ok: false,
      error,
    },
    error: evaluation?.diagnostic || formatAgentResultError(error),
    failureKind: "agent-result-invalid",
    failureSummary: "Agent 结构化结果未通过校验",
    failureAction: "检查 final.txt 与 run.json 中的脱敏校验错误。",
    retryableFailure: false,
  }
}

export function buildAgentResultOutputSchema(context) {
  const normalizedContext = createAgentResultContext({
    stage: context?.stage,
    projectKey: context?.projectKey,
    issue: {
      id: context?.target?.issueId,
      parentId: context?.parentIssueId,
    },
  })
  if (
    normalizedContext.target.platform !== context?.target?.platform ||
    !sameOperations(normalizedContext.allowedOperations, context?.allowedOperations)
  ) {
    throw new Error("Agent 结果输出 schema 的运行绑定与阶段授权不一致。")
  }

  const operationSchemas = normalizedContext.allowedOperations.map((operation) =>
    operationSchema(operation),
  )
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "run", "target", "operations"],
    properties: {
      schemaVersion: singletonStringSchema(AGENT_RESULT_SCHEMA_VERSION),
      run: {
        type: "object",
        additionalProperties: false,
        required: ["stage", "projectKey", "parentIssueId", "allowedOperations"],
        properties: {
          stage: singletonStringSchema(normalizedContext.stage),
          projectKey: singletonStringSchema(normalizedContext.projectKey),
          parentIssueId:
            normalizedContext.parentIssueId === null
              ? { type: "null" }
              : singletonStringSchema(normalizedContext.parentIssueId),
          allowedOperations: {
            type: "array",
            items: {
              type: "string",
              enum: normalizedContext.allowedOperations,
            },
          },
        },
      },
      target: {
        type: "object",
        additionalProperties: false,
        required: ["platform", "issueId"],
        properties: {
          platform: singletonStringSchema(normalizedContext.target.platform),
          issueId: singletonStringSchema(normalizedContext.target.issueId),
        },
      },
      operations: {
        type: "array",
        items: operationSchemas.length ? { anyOf: operationSchemas } : false,
      },
    },
  }
}

export function formatAgentResultError(error) {
  const code = String(error?.code || "INVALID_CONTEXT")
  const path = String(error?.path || "context")
  const message = String(error?.message || "运行校验上下文不合法。")
  return `Agent 结构化结果校验失败: ${code} (${path}) ${message}`
}

function resolveParentIssueId(issue) {
  const parentId = issue?.parent?.id ?? issue?.parentId ?? null
  return parentId == null ? null : String(parentId).trim() || null
}

function sameOperations(left, right) {
  return (
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((operation, index) => operation === right[index])
  )
}

function operationSchema(operation) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "idempotencyKey", "payload"],
    properties: {
      type: singletonStringSchema(operation),
      idempotencyKey: { type: "string" },
      payload: payloadSchema(operation),
    },
  }
}

function payloadSchema(operation) {
  if (operation === AGENT_RESULT_OPERATION.READ_ISSUE) {
    return objectSchema(
      {
        include: {
          type: "array",
          items: {
            type: "string",
            enum: ["comments", "attachments", "relations"],
          },
        },
      },
      ["include"],
    )
  }
  if (operation === AGENT_RESULT_OPERATION.CREATE_COMMENT) {
    return objectSchema({ body: { type: "string" } }, ["body"])
  }
  if (operation === AGENT_RESULT_OPERATION.UPDATE_ISSUE_STATE) {
    return objectSchema({ state: { type: "string" } }, ["state"])
  }
  if (operation === AGENT_RESULT_OPERATION.CREATE_CHILD_ISSUE) {
    return objectSchema(
      {
        title: { type: "string" },
        description: { type: "string" },
      },
      ["title", "description"],
    )
  }
  return objectSchema(
    {
      filePath: { type: "string" },
      title: { type: "string" },
    },
    ["filePath", "title"],
  )
}

function objectSchema(properties, required) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  }
}

function singletonStringSchema(value) {
  return { type: "string", enum: [value] }
}
