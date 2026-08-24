import { randomUUID } from "node:crypto"

import { validateAgentResult } from "./agent-result-protocol.mjs"
import {
  ISSUE_PLATFORM_ERROR_CODE,
  ISSUE_PLATFORM_METHOD_BY_OPERATION,
  ISSUE_PLATFORM_OPERATION,
  IssuePlatformError,
  normalizeIssuePlatformError,
} from "./issue-platform.mjs"
import { verifyLinearOperation } from "./linear-write-verification.mjs"

export const ISSUE_OPERATION_EXECUTION_VERSION = 1

export function createIssueOperationExecutor({ store, platforms, checkpoint } = {}) {
  if (
    !store ||
    typeof store.prepareIssueOperation !== "function" ||
    typeof store.getIssueOperation !== "function" ||
    typeof store.updateIssueOperation !== "function"
  ) {
    throw new TypeError("事项操作执行器需要持久化 operation store。")
  }
  const registry = normalizePlatforms(platforms)

  async function execute({ run, project, config, agentResult } = {}) {
    const validation = validateAgentResult(agentResult, run?.agentResultContext)
    if (!validation.ok) {
      return manualRequired(platformError(
        ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
        null,
        "$",
      ))
    }
    const result = validation.value
    if (result.operations.length === 0) {
      return completed([])
    }

    const platform = registry.get(result.target.platform)
    if (!platform) {
      return manualRequired(platformError(
        ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
        null,
        "$.target.platform",
      ))
    }
    const supported = new Set(platform.writer.supportedOperations || [])
    const unsupported = result.operations.find((item) => !supported.has(item.type))
    if (unsupported) {
      return manualRequired(platformError(
        ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
        unsupported.type,
        "$.payload",
      ))
    }

    let preflight
    try {
      preflight = await buildPreflight({
        run,
        project,
        config,
        result,
        reader: platform.reader,
        store,
      })
    } catch (error) {
      return executionFailure(error)
    }
    if (preflight.error) {
      return manualRequired(preflight.error)
    }

    return executePreparedOperations({
      run,
      result,
      platform,
      preflight,
      store,
      checkpoint,
    })
  }

  return Object.freeze({ execute })
}

async function buildPreflight({ run, project, config, result, reader, store }) {
  if (
    !run?.id ||
    run.projectKey !== project?.key ||
    result.run.projectKey !== project?.key ||
    result.target.issueId !== run.issueId ||
    result.target.issueId !== run.issueBinding?.issueId ||
    result.target.platform !== run.issueBinding?.platform
  ) {
    return { error: platformError(ISSUE_PLATFORM_ERROR_CODE.CONFLICT) }
  }

  const [issue, linearProject] = await Promise.all([
    reader.readIssue(result.target.issueId),
    reader.readProject(project.linearProjectId),
  ])
  rejectIncomplete(issue)
  rejectIncomplete(linearProject)
  if (
    issue.id !== result.target.issueId ||
    issue.project?.id !== project.linearProjectId ||
    issue.project?.id !== run.issueBinding.projectId ||
    linearProject.id !== project.linearProjectId ||
    issue.team?.id !== run.issueBinding.teamId ||
    !linearProject.teams?.some((team) => team.id === issue.team?.id)
  ) {
    return { error: platformError(ISSUE_PLATFORM_ERROR_CODE.CONFLICT) }
  }

  const workflowStates = await reader.listTeamWorkflowStates(issue.team.id)
  const currentState = workflowStates.find((state) => state.id === issue.state?.id)
  if (!currentState || currentState.name !== issue.state?.name || currentState.archivedAt) {
    return { error: platformError(ISSUE_PLATFORM_ERROR_CODE.CONFLICT) }
  }

  const policy = statePolicy(config?.statuses, result.run.stage)
  if (!policy) {
    return { error: platformError(ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST) }
  }
  const stateIntents = new Map()
  for (const operation of result.operations) {
    if (operation.type !== ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE) continue
    if (stateIntents.size > 0) {
      return {
        error: platformError(
          ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
          operation.type,
          "$.payload.state",
        ),
      }
    }
    if (!policy.targets.has(operation.payload.state)) {
      return {
        error: platformError(
          ISSUE_PLATFORM_ERROR_CODE.CONFLICT,
          operation.type,
          "$.payload.state",
        ),
      }
    }
    const targetState = workflowStates.find(
      (state) => state.name === operation.payload.state && !state.archivedAt,
    )
    if (!targetState) {
      return {
        error: platformError(
          ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND,
          operation.type,
          "$.payload.state",
        ),
      }
    }
    stateIntents.set(operation.idempotencyKey, targetState)
  }

  const operationInputs = await Promise.all(result.operations.map(async (operation, sequence) => {
    const scope = operationScope(result, project.key, operation)
    return {
      operation,
      sequence,
      scope,
      existing: await store.getIssueOperation(scope),
    }
  }))
  for (const input of operationInputs) {
    if (
      input.existing &&
      !sameStoredIntent(input.existing, run, input, stateIntents)
    ) {
      return {
        error: platformError(
          ISSUE_PLATFORM_ERROR_CODE.CONFLICT,
          input.operation.type,
          "$.idempotencyKey",
        ),
      }
    }
  }

  const currentIsStageInput = policy.inputs.has(currentState.name)
  const currentIsRecoveredTarget = operationInputs.some((input) => {
    const state = stateIntents.get(input.operation.idempotencyKey)
    return input.existing && state?.id === currentState.id && state.name === currentState.name
  })
  const currentMatchesRunBinding =
    run.issueBinding.stateId === currentState.id &&
    run.issueBinding.stateName === currentState.name
  if (!currentIsStageInput || !currentMatchesRunBinding) {
    if (!currentIsRecoveredTarget) {
      return { error: platformError(ISSUE_PLATFORM_ERROR_CODE.CONFLICT) }
    }
  }

  return {
    issue,
    operationInputs,
    stateIntents,
  }
}

async function executePreparedOperations({
  run,
  result,
  platform,
  preflight,
  store,
  checkpoint,
}) {
  const prepared = []
  for (const input of preflight.operationInputs) {
    const intent = input.operation.type === ISSUE_PLATFORM_OPERATION.CREATE_COMMENT
      ? { commentId: randomUUID() }
      : input.operation.type === ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE
        ? { state: preflight.stateIntents.get(input.operation.idempotencyKey) }
        : {}
    const entry = await store.prepareIssueOperation({
      scope: input.scope,
      runId: run.id,
      stage: result.run.stage,
      sequence: input.sequence,
      payload: input.operation.payload,
      intent,
    })
    prepared.push({ ...input, record: entry.record })
  }
  await checkpoint?.("after-intents-persisted", { run, operations: prepared })

  let issue = preflight.issue
  for (const input of prepared) {
    let record = input.record
    const before = verifyLinearOperation({
      operation: input.operation,
      intent: record.intent,
      issue,
    })
    if (before.status === "verified") {
      record = await store.updateIssueOperation(input.scope, {
        status: "verified",
        verification: verifiedRecord(before),
        error: undefined,
      })
      input.record = record
      continue
    }
    if (before.status === "conflict" || ["provider-succeeded", "verified"].includes(record.status)) {
      record = await store.updateIssueOperation(input.scope, {
        status: "manual-required",
        verification: failedVerification(before),
        error: platformError(
          ISSUE_PLATFORM_ERROR_CODE.CONFLICT,
          input.operation.type,
        ),
      })
      input.record = record
      return manualRequired(record.error, prepared.map(operationResult))
    }
    if (record.status === "manual-required") {
      return manualRequired(
        record.error || platformError(
          ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
          input.operation.type,
        ),
        prepared.map(operationResult),
      )
    }

    record = await store.updateIssueOperation(input.scope, (current) => ({
      status: "attempting",
      attempts: Number(current.attempts || 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      error: undefined,
    }))
    input.record = record

    let providerResult
    try {
      providerResult = await callWriter(platform.writer, input, record.intent)
    } catch (error) {
      const failure = await recoverAfterWriteFailure({
        error,
        input,
        reader: platform.reader,
        store,
      })
      input.record = failure.record
      if (failure.verifiedIssue) {
        issue = failure.verifiedIssue
        continue
      }
      return failure.error.retryable
        ? retryableFailure(failure.error, prepared.map(operationResult))
        : manualRequired(failure.error, prepared.map(operationResult))
    }

    await checkpoint?.("after-provider-write", {
      run,
      operation: input.operation,
      providerResult,
    })
    record = await store.updateIssueOperation(input.scope, {
      status: "provider-succeeded",
      provider: {
        status: "succeeded",
        resourceId: providerResult?.id || record.intent.commentId || record.intent.state?.id || null,
        completedAt: new Date().toISOString(),
      },
      error: undefined,
    })
    input.record = record

    let refreshed
    try {
      refreshed = await platform.reader.readIssue(result.target.issueId)
      rejectIncomplete(refreshed)
    } catch (error) {
      const readError = normalizeIssuePlatformError(error, {
        code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
        operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
      })
      record = await store.updateIssueOperation(input.scope, {
        status: readError.retryable ? "retryable" : "manual-required",
        verification: {
          status: "refresh-failed",
          checkedAt: new Date().toISOString(),
        },
        error: readError,
      })
      input.record = record
      return readError.retryable
        ? retryableFailure(readError, prepared.map(operationResult))
        : manualRequired(readError, prepared.map(operationResult))
    }

    const after = verifyLinearOperation({
      operation: input.operation,
      intent: record.intent,
      issue: refreshed,
    })
    if (after.status !== "verified") {
      const error = platformError(
        after.status === "conflict"
          ? ISSUE_PLATFORM_ERROR_CODE.CONFLICT
          : ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
        input.operation.type,
      )
      record = await store.updateIssueOperation(input.scope, {
        status: "manual-required",
        verification: failedVerification(after),
        error,
      })
      input.record = record
      return manualRequired(error, prepared.map(operationResult))
    }
    record = await store.updateIssueOperation(input.scope, {
      status: "verified",
      verification: verifiedRecord(after),
      error: undefined,
    })
    input.record = record
    issue = refreshed
  }

  return completed(prepared.map(operationResult))
}

async function recoverAfterWriteFailure({ error, input, reader, store }) {
  const writeError = normalizeIssuePlatformError(error, {
    code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    operation: input.operation.type,
  })
  let refreshFailed = false
  try {
    const refreshed = await reader.readIssue(input.scope.issueId)
    rejectIncomplete(refreshed)
    const verification = verifyLinearOperation({
      operation: input.operation,
      intent: input.record.intent,
      issue: refreshed,
    })
    if (verification.status === "verified") {
      const record = await store.updateIssueOperation(input.scope, {
        status: "verified",
        verification: verifiedRecord(verification),
        error: undefined,
      })
      return { record, verifiedIssue: refreshed, error: null }
    }
    if (verification.status === "conflict") {
      const conflict = platformError(
        ISSUE_PLATFORM_ERROR_CODE.CONFLICT,
        input.operation.type,
      )
      const record = await store.updateIssueOperation(input.scope, {
        status: "manual-required",
        verification: failedVerification(verification),
        error: conflict,
      })
      return { record, verifiedIssue: null, error: conflict }
    }
  } catch (refreshError) {
    const normalizedRefresh = normalizeIssuePlatformError(refreshError, {
      code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
      operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
    })
    if (!writeError.retryable || !normalizedRefresh.retryable) {
      const record = await store.updateIssueOperation(input.scope, {
        status: "manual-required",
        verification: {
          status: "refresh-failed",
          checkedAt: new Date().toISOString(),
        },
        error: writeError,
      })
      return { record, verifiedIssue: null, error: writeError }
    }
    refreshFailed = true
  }

  const record = await store.updateIssueOperation(input.scope, {
    status: writeError.retryable ? "retryable" : "manual-required",
    verification: {
      status: refreshFailed ? "refresh-failed" : "not-applied",
      checkedAt: new Date().toISOString(),
    },
    error: writeError,
  })
  return { record, verifiedIssue: null, error: writeError }
}

function callWriter(writer, input, intent) {
  const operation = input.operation
  const request = {
    target: {
      platform: writer.platform,
      issueId: input.scope.issueId,
    },
    idempotencyKey: operation.idempotencyKey,
    payload: operation.payload,
  }
  if (operation.type === ISSUE_PLATFORM_OPERATION.CREATE_COMMENT) {
    return writer.createComment(request, { commentId: intent.commentId })
  }
  return writer.updateIssueState(request, { stateId: intent.state.id })
}

function verifiedRecord(verification) {
  return {
    status: "verified",
    resourceId: verification.resourceId,
    checkedAt: new Date().toISOString(),
  }
}

function failedVerification(verification) {
  return {
    status: verification.status,
    resourceId: verification.resourceId,
    checkedAt: new Date().toISOString(),
  }
}

function statePolicy(statuses, stage) {
  if (!statuses) return null
  const policies = {
    part1: {
      inputs: [statuses.todo, statuses.needsClarification, statuses.tooLarge, statuses.blocked],
      targets: [statuses.ready, statuses.needsClarification, statuses.tooLarge, statuses.blocked],
    },
    split: {
      inputs: [statuses.needsSplitting],
      targets: [statuses.inProgress, statuses.needsClarification, statuses.blocked],
    },
    part2: {
      inputs: [statuses.schedule],
      targets: [statuses.testing, statuses.needsClarification, statuses.blocked],
    },
    part3: {
      inputs: [statuses.testing],
      targets: [statuses.readyForReview, statuses.schedule, statuses.blocked],
    },
  }
  const policy = policies[stage]
  return policy
    ? { inputs: new Set(policy.inputs.filter(Boolean)), targets: new Set(policy.targets.filter(Boolean)) }
    : null
}

function operationScope(result, projectKey, operation) {
  return {
    platform: result.target.platform,
    projectKey,
    issueId: result.target.issueId,
    type: operation.type,
    idempotencyKey: operation.idempotencyKey,
  }
}

function sameStoredIntent(record, run, input, stateIntents) {
  const scopeMatches = JSON.stringify(record.scope) === JSON.stringify(input.scope)
  const intentMatches = input.operation.type === ISSUE_PLATFORM_OPERATION.CREATE_COMMENT
    ? Boolean(String(record.intent?.commentId || "").trim())
    : input.operation.type === ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE
      ? record.intent?.state?.id === stateIntents.get(input.operation.idempotencyKey)?.id &&
        record.intent?.state?.name === stateIntents.get(input.operation.idempotencyKey)?.name
      : false
  return (
    record.version === 1 &&
    scopeMatches &&
    record.stage === run.stage &&
    record.sequence === input.sequence &&
    JSON.stringify(record.payload) === JSON.stringify(input.operation.payload) &&
    intentMatches &&
    Number.isInteger(record.attempts) &&
    record.attempts >= 0
  )
}

function normalizePlatforms(platforms) {
  const registry = new Map()
  for (const [key, value] of Object.entries(platforms || {})) {
    const supportedOperations = value?.writer?.supportedOperations
    if (
      key !== value?.reader?.platform ||
      key !== value?.writer?.platform ||
      !Array.isArray(supportedOperations) ||
      new Set(supportedOperations).size !== supportedOperations.length ||
      typeof value.reader.readIssue !== "function" ||
      typeof value.reader.readProject !== "function" ||
      typeof value.reader.listTeamWorkflowStates !== "function"
    ) {
      throw new TypeError("事项操作执行器的平台注册不完整。")
    }
    for (const operation of supportedOperations) {
      const method = ISSUE_PLATFORM_METHOD_BY_OPERATION[operation]
      if (!method || typeof value.writer[method] !== "function") {
        throw new TypeError("事项操作执行器的写处理器注册不完整。")
      }
    }
    registry.set(key, value)
  }
  return registry
}

function rejectIncomplete(value) {
  if (!value || value.complete === false) {
    throw new IssuePlatformError({
      code: ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED,
      operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
      retryable: true,
    })
  }
}

function executionFailure(error) {
  const normalized = normalizeIssuePlatformError(error, {
    code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
  })
  return normalized.retryable
    ? retryableFailure(normalized)
    : manualRequired(normalized)
}

function platformError(code, operation = null, path = "$") {
  return new IssuePlatformError({ code, operation, path }).toJSON()
}

function operationResult(input) {
  return {
    type: input.operation.type,
    idempotencyKey: input.operation.idempotencyKey,
    status: input.record.status,
    attempts: input.record.attempts,
  }
}

function completed(operations) {
  return {
    version: ISSUE_OPERATION_EXECUTION_VERSION,
    status: "completed",
    safeTerminal: true,
    operations,
  }
}

function retryableFailure(error, operations = []) {
  return {
    version: ISSUE_OPERATION_EXECUTION_VERSION,
    status: "retryable",
    safeTerminal: false,
    error,
    operations,
  }
}

function manualRequired(error, operations = []) {
  return {
    version: ISSUE_OPERATION_EXECUTION_VERSION,
    status: "manual-required",
    safeTerminal: true,
    error: error instanceof IssuePlatformError ? error.toJSON() : error,
    operations,
  }
}
