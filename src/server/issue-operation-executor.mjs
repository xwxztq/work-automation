import { createHash, randomUUID } from "node:crypto"

import { validateAgentResult } from "./agent-result-protocol.mjs"
import {
  ISSUE_PLATFORM_ERROR_CODE,
  ISSUE_PLATFORM_METHOD_BY_OPERATION,
  ISSUE_PLATFORM_OPERATION,
  IssuePlatformError,
  normalizeIssuePlatformError,
} from "./issue-platform.mjs"
import { prepareRunImages, recheckRunImages } from "./run-images.mjs"
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
  const projectTeam = linearProject.teams?.find((team) => team.id === issue.team?.id)
  if (
    issue.archivedAt ||
    issue.project?.archivedAt ||
    issue.team?.archivedAt ||
    linearProject.archivedAt ||
    projectTeam?.archivedAt
  ) {
    return { error: platformError(ISSUE_PLATFORM_ERROR_CODE.ARCHIVED) }
  }
  if (
    issue.id !== result.target.issueId ||
    issue.project?.id !== project.linearProjectId ||
    issue.project?.id !== run.issueBinding.projectId ||
    linearProject.id !== project.linearProjectId ||
    issue.team?.id !== run.issueBinding.teamId ||
    !projectTeam
  ) {
    return { error: platformError(ISSUE_PLATFORM_ERROR_CODE.CONFLICT) }
  }

  const childBatch = validateChildBatch(result, config?.statuses)
  if (childBatch.error) {
    return childBatch
  }
  const childIntents = buildChildIntents(result, issue)
  if (childIntents.error) {
    return childIntents
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
      !sameStoredIntent(
        input.existing,
        run,
        input,
        stateIntents,
        childIntents.value,
      )
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

  await prepareRunImages(run, operationInputs)

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
    childIntents: childIntents.value,
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
      ? { commentId: randomUUID(), ...input.imageIntent }
      : input.operation.type === ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE
        ? { state: preflight.stateIntents.get(input.operation.idempotencyKey) }
        : input.operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE
          ? {
              childIssueId: randomUUID(),
              ...preflight.childIntents.get(input.operation.idempotencyKey),
            }
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

  try {
    await recheckRunImages(run, prepared)
  } catch (error) {
    return executionFailure(error)
  }

  let issue = preflight.issue
  for (const input of prepared) {
    let record = input.record
    if (input.operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE) {
      const childExecution = await executePreparedChildIssue({
        run,
        input,
        platform,
        store,
        checkpoint,
      })
      input.record = childExecution.record
      if (childExecution.status === "verified") {
        continue
      }
      return childExecution.status === "retryable"
        ? retryableFailure(childExecution.error, prepared.map(operationResult))
        : manualRequired(childExecution.error, prepared.map(operationResult))
    }
    const before = await verifyOperation({
      writer: platform.writer,
      operation: input.operation,
      intent: record.intent,
      issue,
    })
    if (before.status === "read-failed") {
      return persistVerificationReadFailure(input, before.error, prepared, store)
    }
    if (before.status === "verified") {
      record = await store.updateIssueOperation(input.scope, {
        status: "verified",
        verification: verifiedRecord(before),
        error: undefined,
      })
      input.record = record
      continue
    }
    if (before.status === "conflict" || ["provider-succeeded", "verified"].includes(record.status) ||
        (record.intent.images?.length && record.attempts > 0)) {
      if (record.intent.images?.length && before.status === "not-applied") {
        before.reason = "图片评论已尝试写入但无法按稳定 ID 找回；为避免重复创建，需要人工检查。"
      }
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
        writer: platform.writer,
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
        resourceId:
          providerResult?.id ||
          record.intent.commentId ||
          record.intent.state?.id ||
          record.intent.childIssueId ||
          null,
        completedAt: new Date().toISOString(),
        ...(record.intent.images?.length ? { body: providerResult?.body || "" } : {}),
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
        status: readError.retryable ? "provider-succeeded" : "manual-required",
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

    const after = await verifyOperation({
      writer: platform.writer,
      operation: input.operation,
      intent: record.intent,
      issue: refreshed,
    })
    if (after.status === "read-failed") {
      return persistVerificationReadFailure(input, after.error, prepared, store)
    }
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

async function executePreparedChildIssue({
  run,
  input,
  platform,
  store,
  checkpoint,
}) {
  let record = input.record
  const before = await readChildVerification({
    reader: platform.reader,
    input,
    record,
  })
  if (before.error) {
    return persistChildReadFailure(input, record, before.error, store)
  }
  if (before.verification.status === "verified") {
    record = await store.updateIssueOperation(input.scope, {
      status: "verified",
      verification: verifiedRecord(before.verification),
      error: undefined,
    })
    return { status: "verified", record, error: null }
  }
  if (
    before.verification.status === "conflict" ||
    record.status === "verified"
  ) {
    return persistChildConflict(input, record, before.verification, store)
  }
  if (record.status === "manual-required") {
    return {
      status: "manual-required",
      record,
      error: record.error || platformError(
        ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
        input.operation.type,
      ),
    }
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
    return recoverAfterChildWriteFailure({
      error,
      input,
      reader: platform.reader,
      store,
    })
  }

  await checkpoint?.("after-provider-write", {
    run,
    operation: input.operation,
    providerResult,
  })
  if (
    providerResult?.id &&
    providerResult.id !== record.intent.childIssueId
  ) {
    return persistChildConflict(input, record, {
      status: "conflict",
      resourceId: record.intent.childIssueId,
    }, store)
  }
  record = await store.updateIssueOperation(input.scope, {
    status: "provider-succeeded",
    provider: {
      status: "succeeded",
      resourceId: record.intent.childIssueId,
      completedAt: new Date().toISOString(),
    },
    error: undefined,
  })
  input.record = record

  const after = await readChildVerification({
    reader: platform.reader,
    input,
    record,
  })
  if (after.error) {
    return persistChildReadFailure(input, record, after.error, store)
  }
  if (after.verification.status === "verified") {
    record = await store.updateIssueOperation(input.scope, {
      status: "verified",
      verification: verifiedRecord(after.verification),
      error: undefined,
    })
    return { status: "verified", record, error: null }
  }
  if (after.verification.status === "conflict") {
    return persistChildConflict(input, record, after.verification, store)
  }

  const error = platformError(
    ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    input.operation.type,
    "$",
    true,
  )
  record = await store.updateIssueOperation(input.scope, {
    status: "retryable",
    verification: failedVerification(after.verification),
    error,
  })
  return { status: "retryable", record, error }
}

async function readChildVerification({ reader, input, record }) {
  try {
    const childIssue = await reader.readIssue(record.intent.childIssueId)
    rejectIncomplete(childIssue)
    return {
      verification: verifyLinearOperation({
        operation: input.operation,
        intent: record.intent,
        issue: childIssue,
      }),
      error: null,
    }
  } catch (error) {
    const normalized = normalizeIssuePlatformError(error, {
      code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
      operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
    })
    if (normalized.code === ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND) {
      return {
        verification: verifyLinearOperation({
          operation: input.operation,
          intent: record.intent,
          issue: null,
        }),
        error: null,
      }
    }
    return { verification: null, error: normalized }
  }
}

async function persistChildReadFailure(input, record, error, store) {
  const status = error.retryable ? "retryable" : "manual-required"
  const updated = await store.updateIssueOperation(input.scope, {
    status,
    verification: {
      status: "refresh-failed",
      resourceId: record.intent.childIssueId,
      checkedAt: new Date().toISOString(),
    },
    error,
  })
  return { status, record: updated, error }
}

async function persistChildConflict(input, record, verification, store) {
  const error = platformError(
    ISSUE_PLATFORM_ERROR_CODE.CONFLICT,
    input.operation.type,
  )
  const updated = await store.updateIssueOperation(input.scope, {
    status: "manual-required",
    verification: failedVerification(verification),
    error,
  })
  return { status: "manual-required", record: updated, error }
}

async function recoverAfterChildWriteFailure({ error, input, reader, store }) {
  const writeError = normalizeIssuePlatformError(error, {
    code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    operation: input.operation.type,
  })
  const recovery = await readChildVerification({
    reader,
    input,
    record: input.record,
  })
  if (recovery.error) {
    const failure = writeError.retryable && recovery.error.retryable
      ? writeError
      : writeError.retryable
        ? recovery.error
        : writeError
    return persistChildReadFailure(input, input.record, failure, store)
  }
  if (recovery.verification.status === "verified") {
    const record = await store.updateIssueOperation(input.scope, {
      status: "verified",
      verification: verifiedRecord(recovery.verification),
      error: undefined,
    })
    return { status: "verified", record, error: null }
  }
  if (recovery.verification.status === "conflict") {
    return persistChildConflict(
      input,
      input.record,
      recovery.verification,
      store,
    )
  }

  const status = writeError.retryable ? "retryable" : "manual-required"
  const record = await store.updateIssueOperation(input.scope, {
    status,
    verification: failedVerification(recovery.verification),
    error: writeError,
  })
  return { status, record, error: writeError }
}

async function recoverAfterWriteFailure({ error, input, reader, writer, store }) {
  const writeError = normalizeIssuePlatformError(error, {
    code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    operation: input.operation.type,
  })
  let refreshFailed = false
  try {
    const refreshed = await reader.readIssue(input.scope.issueId)
    rejectIncomplete(refreshed)
    const verification = await verifyOperation({
      writer,
      operation: input.operation,
      intent: input.record.intent,
      issue: refreshed,
    })
    if (verification.status === "read-failed") throw new IssuePlatformError(verification.error)
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
    return writer.createComment({ ...request, payload: { body: input.imageBody ?? request.payload.body } }, { commentId: intent.commentId })
  }
  if (operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE) {
    return writer.createChildIssue(request, {
      childIssueId: intent.childIssueId,
      teamId: intent.teamId,
      projectId: intent.projectId,
      priority: intent.priority,
    })
  }
  return writer.updateIssueState(request, { stateId: intent.state.id })
}

async function verifyOperation({ writer, operation, intent, issue }) {
  const basic = verifyLinearOperation({ operation, intent, issue })
  if (basic.status !== "images-required") return basic
  if (typeof writer?.verifyCommentImages !== "function") return { status: "conflict", resourceId: intent.commentId }
  try {
    return await writer.verifyCommentImages({ operation, intent, comment: basic.comment })
  } catch (error) {
    return { status: "read-failed", error: normalizeIssuePlatformError(error, { operation: operation.type }) }
  }
}

async function persistVerificationReadFailure(input, error, prepared, store) {
  input.record = await store.updateIssueOperation(input.scope, {
    status: error.retryable
      ? (["verified", "provider-succeeded"].includes(input.record.status) ? "provider-succeeded" : "retryable")
      : "manual-required",
    verification: { status: "refresh-failed", checkedAt: new Date().toISOString() },
    error,
  })
  return error.retryable
    ? retryableFailure(error, prepared.map(operationResult))
    : manualRequired(error, prepared.map(operationResult))
}

function verifiedRecord(verification) {
  return {
    status: "verified",
    resourceId: verification.resourceId,
    checkedAt: new Date().toISOString(),
    ...(verification.references ? { references: verification.references } : {}),
  }
}

function failedVerification(verification) {
  return {
    status: verification.status,
    ...(verification.reason ? { reason: verification.reason } : {}),
    resourceId: verification.resourceId,
    checkedAt: new Date().toISOString(),
  }
}

function validateChildBatch(result, statuses) {
  const children = result.operations.filter(
    (operation) => operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
  )
  if (children.length === 0) {
    return { value: null }
  }
  if (result.run.stage !== "split") {
    return {
      error: platformError(
        ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
        ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
      ),
    }
  }
  const firstNonChild = result.operations.findIndex(
    (operation) => operation.type !== ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
  )
  if (
    firstNonChild !== children.length ||
    result.operations.slice(firstNonChild).some(
      (operation) => operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
    )
  ) {
    return {
      error: platformError(
        ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
        ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
        "$.payload",
      ),
    }
  }
  const comments = result.operations.filter(
    (operation) => operation.type === ISSUE_PLATFORM_OPERATION.CREATE_COMMENT,
  )
  const stateUpdates = result.operations.filter(
    (operation) => operation.type === ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE,
  )
  if (
    comments.length !== 1 ||
    stateUpdates.length !== 1 ||
    result.operations.at(-1) !== stateUpdates[0] ||
    stateUpdates[0].payload.state !== statuses?.inProgress
  ) {
    return {
      error: platformError(
        ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
        ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
        "$.payload",
      ),
    }
  }
  for (const child of children) {
    if (!String(child.payload.description || "").trim()) {
      return {
        error: platformError(
          ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
          child.type,
          "$.payload.description",
        ),
      }
    }
    if (countKeyOccurrences(comments[0].payload.body, child.idempotencyKey) !== 1) {
      return {
        error: platformError(
          ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST,
          child.type,
          "$.idempotencyKey",
        ),
      }
    }
  }
  return { value: children }
}

function buildChildIntents(result, parentIssue) {
  const children = result.operations.filter(
    (operation) => operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
  )
  if (children.length === 0) {
    return { value: new Map() }
  }
  const priority = parentIssue.priority
  if (
    !parentIssue.id ||
    !parentIssue.team?.id ||
    !parentIssue.project?.id ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 4
  ) {
    return {
      error: platformError(
        ISSUE_PLATFORM_ERROR_CODE.CONFLICT,
        ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE,
      ),
    }
  }
  return {
    value: new Map(children.map((operation) => {
      const binding = {
        parentIssueId: parentIssue.id,
        teamId: parentIssue.team.id,
        projectId: parentIssue.project.id,
        priority,
      }
      return [
        operation.idempotencyKey,
        {
          ...binding,
          requestFingerprint: childRequestFingerprint(result, operation, binding),
        },
      ]
    })),
  }
}

function childRequestFingerprint(result, operation, binding) {
  return createHash("sha256")
    .update(JSON.stringify({
      platform: result.target.platform,
      parentIssueId: result.target.issueId,
      operation: operation.type,
      idempotencyKey: operation.idempotencyKey,
      payload: {
        title: operation.payload.title,
        description: operation.payload.description,
      },
      inheritance: binding,
    }))
    .digest("hex")
}

function countKeyOccurrences(text, search) {
  let count = 0
  let offset = 0
  while (offset <= text.length - search.length) {
    const index = text.indexOf(search, offset)
    if (index < 0) break
    const before = index > 0 ? text[index - 1] : ""
    const after = text[index + search.length] || ""
    if (!isIdempotencyKeyCharacter(before) && !isIdempotencyKeyCharacter(after)) {
      count += 1
    }
    offset = index + search.length
  }
  return count
}

function isIdempotencyKeyCharacter(value) {
  return Boolean(value) && /[A-Za-z0-9._:/-]/u.test(value)
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

function sameStoredIntent(record, run, input, stateIntents, childIntents) {
  const scopeMatches = JSON.stringify(record.scope) === JSON.stringify(input.scope)
  const payloadMatches = input.operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE
    ? record.payload?.title === input.operation.payload.title &&
      record.payload?.description === input.operation.payload.description
    : JSON.stringify(record.payload) === JSON.stringify(input.operation.payload)
  const intentMatches = input.operation.type === ISSUE_PLATFORM_OPERATION.CREATE_COMMENT
    ? Boolean(String(record.intent?.commentId || "").trim())
    : input.operation.type === ISSUE_PLATFORM_OPERATION.UPDATE_ISSUE_STATE
      ? record.intent?.state?.id === stateIntents.get(input.operation.idempotencyKey)?.id &&
        record.intent?.state?.name === stateIntents.get(input.operation.idempotencyKey)?.name
      : input.operation.type === ISSUE_PLATFORM_OPERATION.CREATE_CHILD_ISSUE
        ? sameChildIntent(
            record.intent,
            childIntents.get(input.operation.idempotencyKey),
          )
        : false
  return (
    record.version === 1 &&
    scopeMatches &&
    record.stage === run.stage &&
    record.sequence === input.sequence &&
    payloadMatches &&
    intentMatches &&
    Number.isInteger(record.attempts) &&
    record.attempts >= 0
  )
}

function sameChildIntent(actual, expected) {
  return (
    Boolean(String(actual?.childIssueId || "").trim()) &&
    actual?.parentIssueId === expected?.parentIssueId &&
    actual?.teamId === expected?.teamId &&
    actual?.projectId === expected?.projectId &&
    actual?.priority === expected?.priority &&
    actual?.requestFingerprint === expected?.requestFingerprint
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

function platformError(code, operation = null, path = "$", retryable = false) {
  return new IssuePlatformError({ code, operation, path, retryable }).toJSON()
}

function operationResult(input) {
  const resourceId = input.record.verification?.status === "verified"
    ? input.record.verification.resourceId
    : null
  return {
    type: input.operation.type,
    idempotencyKey: input.operation.idempotencyKey,
    status: input.record.status,
    attempts: input.record.attempts,
    ...(resourceId ? { resourceId } : {}),
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
