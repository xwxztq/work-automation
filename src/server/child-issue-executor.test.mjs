import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createAgentResultContext } from "./agent-result-runtime.mjs"
import { createIssueOperationExecutor } from "./issue-operation-executor.mjs"
import { IssuePlatformError } from "./issue-platform.mjs"
import { createRunStore } from "./run-store.mjs"

const statuses = {
  todo: "Todo",
  needsClarification: "Needs Clarification",
  tooLarge: "Too Large",
  needsSplitting: "Needs Splitting",
  blocked: "Blocked",
  ready: "Ready for Codex",
  schedule: "On Schedule",
  inProgress: "In Progress",
  testing: "Testing",
  readyForReview: "Ready for Review",
}

test("creates inherited child issues once and returns stable IDs on replay", async (t) => {
  const fixture = await createFixture(t)
  const agentResult = splitResult(fixture)

  const first = await execute(fixture, agentResult)
  const replay = await execute(fixture, agentResult)
  const childResults = first.operations.filter((item) => item.type === "issue.child.create")
  const replayChildResults = replay.operations.filter(
    (item) => item.type === "issue.child.create",
  )

  assert.equal(first.status, "completed")
  assert.equal(replay.status, "completed")
  assert.deepEqual(
    fixture.mutations.map((item) => item.type),
    [
      "issue.child.create",
      "issue.child.create",
      "comment.create",
      "issue.state.update",
    ],
  )
  assert.equal(fixture.children.size, 2)
  for (const child of fixture.children.values()) {
    assert.equal(child.parentIssueId, "issue-1175")
    assert.notEqual(child.parentIssueId, fixture.run.agentResultContext.parentIssueId)
    assert.equal(child.team.id, "team-liv")
    assert.equal(child.project.id, "project-work-automation")
    assert.equal(child.priority, 2)
  }
  assert.deepEqual(
    replayChildResults.map((item) => item.resourceId),
    childResults.map((item) => item.resourceId),
  )
  assert.equal(childResults.every((item) => item.status === "verified"), true)

  const record = await fixture.store.getIssueOperation(operationScope(
    agentResult.operations[0],
  ))
  assert.equal(record.intent.childIssueId, childResults[0].resourceId)
  assert.match(record.intent.requestFingerprint, /^[a-f0-9]{64}$/u)
})

test("rejects invalid child batches and target drift before issueCreate", async (t) => {
  await t.test("missing description", async (t) => {
    const fixture = await createFixture(t)
    const agentResult = splitResult(fixture, [{
      idempotencyKey: "issue-1175:split:child-a",
      title: "Child A",
      description: "",
    }])

    const execution = await execute(fixture, agentResult)

    assert.equal(execution.status, "manual-required")
    assert.equal(execution.error.code, "INVALID_REQUEST")
    assert.equal(execution.error.path, "$.payload.description")
    assert.equal(fixture.mutations.length, 0)
  })

  await t.test("coverage key mismatch", async (t) => {
    const fixture = await createFixture(t)
    const agentResult = splitResult(fixture)
    const comment = agentResult.operations.find((item) => item.type === "comment.create")
    comment.payload.body = "Codex Split Complete\n\n覆盖清单缺少稳定键。"

    const execution = await execute(fixture, agentResult)

    assert.equal(execution.status, "manual-required")
    assert.equal(execution.error.code, "INVALID_REQUEST")
    assert.equal(execution.error.path, "$.idempotencyKey")
    assert.equal(fixture.mutations.length, 0)
  })

  await t.test("coverage key repeated", async (t) => {
    const fixture = await createFixture(t)
    const agentResult = splitResult(fixture)
    const comment = agentResult.operations.find((item) => item.type === "comment.create")
    comment.payload.body += `\n- duplicate: ${agentResult.operations[0].idempotencyKey}`

    const execution = await execute(fixture, agentResult)

    assert.equal(execution.status, "manual-required")
    assert.equal(execution.error.code, "INVALID_REQUEST")
    assert.equal(execution.error.path, "$.idempotencyKey")
    assert.equal(fixture.mutations.length, 0)
  })

  await t.test("configured project mismatch", async (t) => {
    const fixture = await createFixture(t)
    fixture.parent.project.id = "other-project"

    const execution = await execute(fixture, splitResult(fixture))

    assert.equal(execution.status, "manual-required")
    assert.equal(execution.error.code, "CONFLICT")
    assert.equal(fixture.mutations.length, 0)
  })

  await t.test("archived team", async (t) => {
    const fixture = await createFixture(t)
    fixture.parent.team.archivedAt = "2026-08-24T00:00:00.000Z"

    const execution = await execute(fixture, splitResult(fixture))

    assert.equal(execution.status, "manual-required")
    assert.equal(execution.error.code, "ARCHIVED")
    assert.equal(fixture.mutations.length, 0)
  })
})

test("recovers a created child after process loss without creating a duplicate", async (t) => {
  let crashed = false
  const fixture = await createFixture(t, {
    checkpoint(name, detail) {
      if (
        !crashed &&
        name === "after-provider-write" &&
        detail.operation.type === "issue.child.create"
      ) {
        crashed = true
        throw new Error("simulated process crash")
      }
    },
  })
  const agentResult = splitResult(fixture, [{
    idempotencyKey: "issue-1175:split:child-a",
    title: "Child A",
    description: "Child A scope",
  }])

  await assert.rejects(execute(fixture, agentResult), /simulated process crash/u)
  assert.equal(fixture.children.size, 1)
  assert.deepEqual(
    fixture.mutations.map((item) => item.type),
    ["issue.child.create"],
  )

  fixture.executor = createIssueOperationExecutor({
    store: createRunStore(fixture.rootDir),
    platforms: fixture.platforms,
  })
  const recovered = await execute(fixture, agentResult)

  assert.equal(recovered.status, "completed")
  assert.deepEqual(
    fixture.mutations.map((item) => item.type),
    ["issue.child.create", "comment.create", "issue.state.update"],
  )
  assert.equal(recovered.operations[0].resourceId, [...fixture.children.keys()][0])
})

test("resumes a partially failed child batch from the first unfinished item", async (t) => {
  const fixture = await createFixture(t, {
    childFailures: { "Child B": 1 },
  })
  const agentResult = splitResult(fixture)

  const first = await execute(fixture, agentResult)
  const pendingRecord = await fixture.store.getIssueOperation(operationScope(
    agentResult.operations[1],
  ))
  const resumed = await execute(fixture, agentResult)

  assert.equal(first.status, "retryable")
  assert.deepEqual(
    first.operations.slice(0, 2).map((item) => item.status),
    ["verified", "retryable"],
  )
  assert.equal(resumed.status, "completed")
  assert.deepEqual(
    fixture.mutations.map((item) => `${item.type}:${item.title || ""}`),
    [
      "issue.child.create:Child A",
      "issue.child.create:Child B",
      "issue.child.create:Child B",
      "comment.create:",
      "issue.state.update:",
    ],
  )
  assert.equal(fixture.children.has(pendingRecord.intent.childIssueId), true)
  assert.equal(resumed.operations[1].resourceId, pendingRecord.intent.childIssueId)
})

test("stops the batch when write-after verification finds inherited-field drift", async (t) => {
  const fixture = await createFixture(t, {
    childOverride(child) {
      return { ...child, priority: 4 }
    },
  })
  const agentResult = splitResult(fixture, [{
    idempotencyKey: "issue-1175:split:child-a",
    title: "Child A",
    description: "Child A scope",
  }])

  const execution = await execute(fixture, agentResult)
  const record = await fixture.store.getIssueOperation(operationScope(
    agentResult.operations[0],
  ))

  assert.equal(execution.status, "manual-required")
  assert.equal(execution.error.code, "CONFLICT")
  assert.deepEqual(
    fixture.mutations.map((item) => item.type),
    ["issue.child.create"],
  )
  assert.equal(record.status, "manual-required")
})

test("reports an idempotency conflict when the same key changes its request", async (t) => {
  const fixture = await createFixture(t)
  const original = splitResult(fixture, [{
    idempotencyKey: "issue-1175:split:child-a",
    title: "Child A",
    description: "Child A scope",
  }])
  assert.equal((await execute(fixture, original)).status, "completed")
  const mutationCount = fixture.mutations.length
  const changed = splitResult(fixture, [{
    idempotencyKey: "issue-1175:split:child-a",
    title: "Changed child",
    description: "Changed scope",
  }])

  const replay = await execute(fixture, changed)

  assert.equal(replay.status, "manual-required")
  assert.equal(replay.error.code, "CONFLICT")
  assert.equal(replay.error.path, "$.idempotencyKey")
  assert.equal(fixture.mutations.length, mutationCount)
})

async function createFixture(t, {
  checkpoint,
  childFailures = {},
  childOverride = (child) => child,
} = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-child-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const parent = {
    id: "issue-1175",
    identifier: "LIV-1175",
    title: "Split target",
    description: "Parent scope",
    target: { platform: "primary-issues", issueId: "issue-1175" },
    priority: 2,
    priorityLabel: "High",
    archivedAt: null,
    project: {
      id: "project-work-automation",
      name: "work-automation",
      archivedAt: null,
    },
    team: {
      id: "team-liv",
      key: "LIV",
      name: "Livehappy-workhappy",
      archivedAt: null,
    },
    state: workflowStates().find((item) => item.name === "Needs Splitting"),
    parent: { id: "issue-1170", identifier: "LIV-1170" },
    parentIssueId: "issue-1170",
    comments: [],
    relations: [],
    attachments: [],
    labels: [],
    complete: true,
  }
  const store = createRunStore(rootDir)
  let run = await store.createRun({
    projectKey: "work-automation",
    stage: "split",
    issue: parent,
  })
  run = await store.updateRun(run, {
    agentResultContext: createAgentResultContext({
      stage: "split",
      projectKey: "work-automation",
      issue: parent,
    }),
  })

  const children = new Map()
  const mutations = []
  const remainingFailures = new Map(Object.entries(childFailures))
  const reader = {
    platform: "primary-issues",
    async readIssue(issueId) {
      if (issueId === parent.id) return structuredClone(parent)
      const child = children.get(issueId)
      if (child) return structuredClone(child)
      throw new IssuePlatformError({
        code: "NOT_FOUND",
        operation: "issue.read",
      })
    },
    async readProject() {
      return {
        id: "project-work-automation",
        name: "work-automation",
        archivedAt: null,
        teams: [{
          id: "team-liv",
          key: "LIV",
          name: "Livehappy-workhappy",
          archivedAt: null,
        }],
        complete: true,
      }
    },
    async listTeamWorkflowStates() {
      return workflowStates()
    },
  }
  const writer = {
    platform: "primary-issues",
    supportedOperations: [
      "issue.child.create",
      "comment.create",
      "issue.state.update",
    ],
    async createChildIssue(request, intent) {
      mutations.push({ type: "issue.child.create", title: request.payload.title })
      const remaining = Number(remainingFailures.get(request.payload.title) || 0)
      if (remaining > 0) {
        remainingFailures.set(request.payload.title, remaining - 1)
        throw new IssuePlatformError({
          code: "RATE_LIMITED",
          operation: "issue.child.create",
          retryable: true,
        })
      }
      const child = childOverride({
        id: intent.childIssueId,
        identifier: `LIV-${1200 + children.size}`,
        target: { platform: "primary-issues", issueId: intent.childIssueId },
        title: request.payload.title,
        description: request.payload.description,
        priority: intent.priority,
        priorityLabel: "High",
        archivedAt: null,
        parent: { id: request.target.issueId, identifier: parent.identifier },
        parentIssueId: request.target.issueId,
        team: { ...parent.team },
        project: { ...parent.project },
        state: workflowStates()[0],
        comments: [],
        relations: [],
        attachments: [],
        labels: [],
        complete: true,
      })
      children.set(child.id, structuredClone(child))
      return structuredClone(child)
    },
    async createComment(request, { commentId }) {
      mutations.push({ type: "comment.create" })
      const comment = {
        id: commentId,
        body: request.payload.body,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
        archivedAt: null,
      }
      parent.comments.push(comment)
      return structuredClone(comment)
    },
    async updateIssueState(_request, { stateId }) {
      mutations.push({ type: "issue.state.update" })
      parent.state = workflowStates().find((item) => item.id === stateId)
      return structuredClone(parent.state)
    },
  }
  const platforms = { "primary-issues": { reader, writer } }
  return {
    children,
    executor: createIssueOperationExecutor({ store, platforms, checkpoint }),
    mutations,
    parent,
    platforms,
    project: {
      key: "work-automation",
      linearProjectId: "project-work-automation",
    },
    rootDir,
    run,
    store,
  }
}

function splitResult(fixture, children = [
  {
    idempotencyKey: "issue-1175:split:child-1",
    title: "Child A",
    description: "Child A scope",
  },
  {
    idempotencyKey: "issue-1175:split:child-10",
    title: "Child B",
    description: "Child B scope",
  },
]) {
  const childOperations = children.map((child) => ({
    type: "issue.child.create",
    idempotencyKey: child.idempotencyKey,
    payload: {
      title: child.title,
      description: child.description,
    },
  }))
  return {
    schemaVersion: "1",
    run: {
      stage: fixture.run.agentResultContext.stage,
      projectKey: fixture.run.agentResultContext.projectKey,
      parentIssueId: fixture.run.agentResultContext.parentIssueId,
      allowedOperations: fixture.run.agentResultContext.allowedOperations,
    },
    target: fixture.run.agentResultContext.target,
    operations: [
      ...childOperations,
      {
        type: "comment.create",
        idempotencyKey: "issue-1175:split:coverage-comment",
        payload: {
          body: [
            "Codex Split Complete",
            "",
            ...children.map((child) => `- ${child.title}: ${child.idempotencyKey}`),
          ].join("\n"),
        },
      },
      {
        type: "issue.state.update",
        idempotencyKey: "issue-1175:split:in-progress-state",
        payload: { state: "In Progress" },
      },
    ],
  }
}

function operationScope(operation) {
  return {
    platform: "primary-issues",
    projectKey: "work-automation",
    issueId: "issue-1175",
    type: operation.type,
    idempotencyKey: operation.idempotencyKey,
  }
}

function execute(fixture, agentResult) {
  return fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })
}

function workflowStates() {
  return [
    { id: "state-backlog", name: "Backlog", type: "backlog", archivedAt: null },
    { id: "state-needs-splitting", name: "Needs Splitting", type: "unstarted", archivedAt: null },
    { id: "state-clarification", name: "Needs Clarification", type: "unstarted", archivedAt: null },
    { id: "state-blocked", name: "Blocked", type: "canceled", archivedAt: null },
    { id: "state-in-progress", name: "In Progress", type: "started", archivedAt: null },
  ]
}
