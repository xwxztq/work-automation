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

test("rejects the part1 approval-boundary transition before any mutation", async (t) => {
  const fixture = await createFixture(t, { stage: "part1", stateName: "Todo" })
  const agentResult = resultFor(fixture, [
    operation("comment.create", "issue-1174:part1:comment", {
      body: "AI Triage: READY",
    }),
    operation("issue.state.update", "issue-1174:part1:state", {
      state: "On Schedule",
    }),
  ])

  const execution = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })

  assert.equal(execution.status, "manual-required")
  assert.equal(execution.safeTerminal, true)
  assert.equal(execution.error.code, "CONFLICT")
  assert.equal(fixture.mutations.length, 0)
})

test("executes comment and state operations once when the result is replayed", async (t) => {
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
  })
  const agentResult = resultFor(fixture, [
    operation("comment.create", "issue-1174:part2:comment", {
      body: "Codex Implementation Complete",
    }),
    operation("issue.state.update", "issue-1174:part2:state", {
      state: "Testing",
    }),
  ])
  let replayRun = await fixture.store.createRun({
    projectKey: "work-automation",
    stage: "part2",
    issue: fixture.issue,
  })
  replayRun = await fixture.store.updateRun(replayRun, {
    agentResultContext: createAgentResultContext({
      stage: "part2",
      projectKey: "work-automation",
      issue: fixture.issue,
    }),
  })

  const first = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })
  const replay = await fixture.executor.execute({
    run: replayRun,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })

  assert.equal(first.status, "completed")
  assert.equal(replay.status, "completed")
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
  assert.equal(fixture.issue.comments.length, 1)
  assert.equal(fixture.issue.state.name, "Testing")
  assert.deepEqual(
    replay.operations.map((item) => item.status),
    ["verified", "verified"],
  )
})

test("resumes only the failed state operation after a comment succeeds", async (t) => {
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    stateFailures: 1,
  })
  const agentResult = resultFor(fixture, [
    operation("comment.create", "issue-1174:part2:partial-comment", {
      body: "Codex Implementation Complete",
    }),
    operation("issue.state.update", "issue-1174:part2:partial-state", {
      state: "Testing",
    }),
  ])

  const first = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })
  const resumed = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })
  const commentRecord = await fixture.store.getIssueOperation({
    platform: "primary-issues",
    projectKey: "work-automation",
    issueId: "issue-1174",
    type: "comment.create",
    idempotencyKey: "issue-1174:part2:partial-comment",
  })
  const stateRecord = await fixture.store.getIssueOperation({
    platform: "primary-issues",
    projectKey: "work-automation",
    issueId: "issue-1174",
    type: "issue.state.update",
    idempotencyKey: "issue-1174:part2:partial-state",
  })

  assert.equal(first.status, "retryable")
  assert.equal(first.safeTerminal, false)
  assert.equal(resumed.status, "completed")
  assert.deepEqual(fixture.mutations, [
    "comment.create",
    "issue.state.update",
    "issue.state.update",
  ])
  assert.equal(fixture.issue.comments.length, 1)
  assert.equal(fixture.issue.state.name, "Testing")
  assert.equal(commentRecord.status, "verified")
  assert.equal(commentRecord.attempts, 1)
  assert.equal(stateRecord.status, "verified")
  assert.equal(stateRecord.attempts, 2)
})

test("restarts after intents are persisted without producing an early mutation", async (t) => {
  let crashed = false
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    checkpoint(name) {
      if (!crashed && name === "after-intents-persisted") {
        crashed = true
        throw new Error("simulated process crash")
      }
    },
  })
  const agentResult = completedPart2Result(fixture, "intent-crash")

  await assert.rejects(
    fixture.executor.execute({
      run: fixture.run,
      project: fixture.project,
      config: { statuses },
      agentResult,
    }),
    /simulated process crash/u,
  )
  assert.deepEqual(fixture.mutations, [])

  const restarted = createIssueOperationExecutor({
    store: createRunStore(fixture.rootDir),
    platforms: fixture.platforms,
  })
  const execution = await restarted.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })

  assert.equal(execution.status, "completed")
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
})

test("recovers a comment written before the local success record without duplicating it", async (t) => {
  let crashed = false
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    checkpoint(name, detail) {
      if (
        !crashed &&
        name === "after-provider-write" &&
        detail.operation.type === "comment.create"
      ) {
        crashed = true
        throw new Error("simulated process crash")
      }
    },
  })
  const agentResult = completedPart2Result(fixture, "provider-crash")

  await assert.rejects(
    fixture.executor.execute({
      run: fixture.run,
      project: fixture.project,
      config: { statuses },
      agentResult,
    }),
    /simulated process crash/u,
  )
  assert.deepEqual(fixture.mutations, ["comment.create"])
  assert.equal(fixture.issue.comments.length, 1)

  const restarted = createIssueOperationExecutor({
    store: createRunStore(fixture.rootDir),
    platforms: fixture.platforms,
  })
  const execution = await restarted.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })

  assert.equal(execution.status, "completed")
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
  assert.equal(fixture.issue.comments.length, 1)
})

test("recovers a state written before the local success record without repeating it", async (t) => {
  let crashed = false
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    checkpoint(name, detail) {
      if (
        !crashed &&
        name === "after-provider-write" &&
        detail.operation.type === "issue.state.update"
      ) {
        crashed = true
        throw new Error("simulated process crash")
      }
    },
  })
  const agentResult = completedPart2Result(fixture, "state-provider-crash")

  await assert.rejects(
    fixture.executor.execute({
      run: fixture.run,
      project: fixture.project,
      config: { statuses },
      agentResult,
    }),
    /simulated process crash/u,
  )
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
  assert.equal(fixture.issue.state.name, "Testing")

  const restarted = createIssueOperationExecutor({
    store: createRunStore(fixture.rootDir),
    platforms: fixture.platforms,
  })
  const execution = await restarted.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })

  assert.equal(execution.status, "completed")
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
  assert.equal(fixture.issue.comments.length, 1)
})

test("stops when Linear reports comment success but the comment is absent", async (t) => {
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    commentMutationApplies: false,
  })

  const execution = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult: completedPart2Result(fixture, "missing-comment"),
  })
  const replay = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult: completedPart2Result(fixture, "missing-comment"),
  })

  assert.equal(execution.status, "manual-required")
  assert.equal(replay.status, "manual-required")
  assert.equal(execution.safeTerminal, true)
  assert.equal(execution.error.code, "OPERATION_FAILED")
  assert.deepEqual(fixture.mutations, ["comment.create"])
  assert.equal(fixture.issue.comments.length, 0)
})

test("stops when Linear reports state success but the state is unchanged", async (t) => {
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    stateMutationApplies: false,
  })

  const execution = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult: completedPart2Result(fixture, "unchanged-state"),
  })

  assert.equal(execution.status, "manual-required")
  assert.equal(execution.error.code, "OPERATION_FAILED")
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
  assert.equal(fixture.issue.state.name, "On Schedule")
})

test("fails closed on an unregistered split operation before later writes", async (t) => {
  const fixture = await createFixture(t, {
    stage: "split",
    stateName: "Needs Splitting",
  })
  const agentResult = resultFor(fixture, [
    operation("issue.child.create", "issue-1174:split:child", {
      title: "Child issue",
      description: "Child scope",
    }),
    operation("comment.create", "issue-1174:split:comment", {
      body: "Codex Split Complete",
    }),
    operation("issue.state.update", "issue-1174:split:state", {
      state: "In Progress",
    }),
  ])

  const execution = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult,
  })

  assert.equal(execution.status, "manual-required")
  assert.equal(execution.error.code, "INVALID_REQUEST")
  assert.equal(fixture.mutations.length, 0)
})

test("rejects changed run bindings before calling the writer", async (t) => {
  const cases = [
    {
      name: "target issue",
      mutate(fixture, result) {
        result.target.issueId = "other-issue"
      },
    },
    {
      name: "configured project",
      mutate(fixture) {
        fixture.project.linearProjectId = "other-project"
      },
    },
    {
      name: "issue team",
      mutate(fixture) {
        fixture.issue.team.id = "other-team"
      },
    },
    {
      name: "stage",
      mutate(_fixture, result) {
        result.run.stage = "part1"
      },
    },
    {
      name: "stage input state",
      mutate(fixture) {
        fixture.issue.state = {
          ...workflowStates().find((item) => item.name === "Testing"),
        }
      },
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fixture = await createFixture(t, {
        stage: "part2",
        stateName: "On Schedule",
      })
      const agentResult = completedPart2Result(fixture, `wrong-${entry.name.replace(" ", "-")}`)
      entry.mutate(fixture, agentResult)

      const execution = await fixture.executor.execute({
        run: fixture.run,
        project: fixture.project,
        config: { statuses },
        agentResult,
      })

      assert.equal(execution.status, "manual-required")
      assert.equal(fixture.mutations.length, 0)
    })
  }
})

test("keeps provider diagnostics out of public and persisted operation errors", async (t) => {
  const privateValue = "LINEAR_API_KEY=private-operation-value"
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    commentFailure: new Error(privateValue),
  })

  const execution = await fixture.executor.execute({
    run: fixture.run,
    project: fixture.project,
    config: { statuses },
    agentResult: completedPart2Result(fixture, "private-error"),
  })
  const files = await fs.readdir(fixture.store.issueOperationsDir)
  const persisted = await Promise.all(files.map((file) =>
    fs.readFile(path.join(fixture.store.issueOperationsDir, file), "utf8")
  ))

  assert.equal(execution.status, "manual-required")
  assert.doesNotMatch(JSON.stringify(execution), /private-operation-value/u)
  assert.doesNotMatch(persisted.join("\n"), /private-operation-value/u)
})

test("applies the configured comment-and-state policy for every stage", async (t) => {
  const cases = [
    { stage: "part1", from: "Todo", to: "Ready for Codex" },
    { stage: "split", from: "Needs Splitting", to: "Blocked" },
    { stage: "part2", from: "On Schedule", to: "Testing" },
    { stage: "part3", from: "Testing", to: "Ready for Review" },
  ]

  for (const entry of cases) {
    await t.test(entry.stage, async (t) => {
      const fixture = await createFixture(t, {
        stage: entry.stage,
        stateName: entry.from,
      })
      const agentResult = resultFor(fixture, [
        operation(
          "comment.create",
          `issue-1174:${entry.stage}:policy-comment`,
          { body: `${entry.stage} result` },
        ),
        operation(
          "issue.state.update",
          `issue-1174:${entry.stage}:policy-state`,
          { state: entry.to },
        ),
      ])

      const execution = await fixture.executor.execute({
        run: fixture.run,
        project: fixture.project,
        config: { statuses },
        agentResult,
      })

      assert.equal(execution.status, "completed")
      assert.equal(fixture.issue.state.name, entry.to)
    })
  }
})

async function createFixture(t, {
  stage,
  stateName,
  stateFailures = 0,
  commentMutationApplies = true,
  stateMutationApplies = true,
  commentFailure = null,
  checkpoint,
}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-executor-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const state = workflowStates().find((item) => item.name === stateName)
  const issue = {
    id: "issue-1174",
    identifier: "LIV-1174",
    title: "Controlled writes",
    target: { platform: "primary-issues", issueId: "issue-1174" },
    project: { id: "project-1", name: "work-automation" },
    team: { id: "team-1", key: "LIV", name: "Livehappy-workhappy" },
    state: { ...state },
    comments: [],
    complete: true,
  }
  const store = createRunStore(rootDir)
  let run = await store.createRun({
    projectKey: "work-automation",
    stage,
    issue,
  })
  const agentResultContext = createAgentResultContext({
    stage,
    projectKey: "work-automation",
    issue,
  })
  run = await store.updateRun(run, { agentResultContext })
  const mutations = []
  let remainingStateFailures = stateFailures
  const reader = {
    platform: "primary-issues",
    async readIssue() {
      return structuredClone(issue)
    },
    async readProject() {
      return {
        id: "project-1",
        name: "work-automation",
        teams: [{ id: "team-1", key: "LIV", name: "Livehappy-workhappy" }],
        complete: true,
      }
    },
    async listTeamWorkflowStates() {
      return workflowStates()
    },
  }
  const writer = {
    platform: "primary-issues",
    supportedOperations: ["comment.create", "issue.state.update"],
    async createComment(request, { commentId }) {
      mutations.push("comment.create")
      if (commentFailure) {
        throw commentFailure
      }
      const comment = {
        id: commentId,
        body: request.payload.body,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
        archivedAt: null,
      }
      if (commentMutationApplies) {
        issue.comments.push(comment)
      }
      return comment
    },
    async updateIssueState(_request, { stateId }) {
      mutations.push("issue.state.update")
      if (remainingStateFailures > 0) {
        remainingStateFailures -= 1
        throw new IssuePlatformError({
          code: "RATE_LIMITED",
          operation: "issue.state.update",
          retryable: true,
        })
      }
      const targetState = { ...workflowStates().find((item) => item.id === stateId) }
      if (stateMutationApplies) {
        issue.state = targetState
      }
      return structuredClone(targetState)
    },
  }
  const platforms = { "primary-issues": { reader, writer } }
  const executor = createIssueOperationExecutor({ store, platforms, checkpoint })
  return {
    executor,
    issue,
    mutations,
    platforms,
    project: {
      key: "work-automation",
      linearProjectId: "project-1",
    },
    rootDir,
    run,
    store,
  }
}

function resultFor(fixture, operations) {
  return {
    schemaVersion: "1",
    run: {
      stage: fixture.run.agentResultContext.stage,
      projectKey: fixture.run.agentResultContext.projectKey,
      parentIssueId: fixture.run.agentResultContext.parentIssueId,
      allowedOperations: fixture.run.agentResultContext.allowedOperations,
    },
    target: fixture.run.agentResultContext.target,
    operations,
  }
}

function operation(type, idempotencyKey, payload) {
  return { type, idempotencyKey, payload }
}

function completedPart2Result(fixture, suffix) {
  return resultFor(fixture, [
    operation("comment.create", `issue-1174:part2:${suffix}:comment`, {
      body: "Codex Implementation Complete",
    }),
    operation("issue.state.update", `issue-1174:part2:${suffix}:state`, {
      state: "Testing",
    }),
  ])
}

function workflowStates() {
  return [
    { id: "state-todo", name: "Todo", type: "unstarted", archivedAt: null },
    { id: "state-clarification", name: "Needs Clarification", type: "unstarted", archivedAt: null },
    { id: "state-too-large", name: "Too Large", type: "unstarted", archivedAt: null },
    { id: "state-needs-splitting", name: "Needs Splitting", type: "unstarted", archivedAt: null },
    { id: "state-blocked", name: "Blocked", type: "canceled", archivedAt: null },
    { id: "state-ready", name: "Ready for Codex", type: "unstarted", archivedAt: null },
    { id: "state-schedule", name: "On Schedule", type: "unstarted", archivedAt: null },
    { id: "state-in-progress", name: "In Progress", type: "started", archivedAt: null },
    { id: "state-testing", name: "Testing", type: "completed", archivedAt: null },
    { id: "state-ready-review", name: "Ready for Review", type: "completed", archivedAt: null },
  ]
}
