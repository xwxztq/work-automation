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

test("does not repeat a successful state mutation after verification is rate limited", async (t) => {
  const fixture = await createFixture(t, {
    stage: "part2",
    stateName: "On Schedule",
    stateMutationApplies: false,
  })
  const reader = fixture.platforms["primary-issues"].reader
  const readIssue = reader.readIssue.bind(reader)
  let reads = 0
  reader.readIssue = async (...args) => {
    reads += 1
    if (reads === 2) {
      throw new IssuePlatformError({
        code: "RATE_LIMITED",
        operation: "issue.read",
        retryable: true,
      })
    }
    return readIssue(...args)
  }
  const idempotencyKey = "issue-1174:part2:refresh-rate-limited-state"
  const agentResult = resultFor(fixture, [
    operation("issue.state.update", idempotencyKey, {
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
  const record = await fixture.store.getIssueOperation({
    platform: "primary-issues",
    projectKey: "work-automation",
    issueId: "issue-1174",
    type: "issue.state.update",
    idempotencyKey,
  })

  assert.equal(first.status, "retryable")
  assert.equal(first.operations[0].status, "provider-succeeded")
  assert.equal(resumed.status, "manual-required")
  assert.deepEqual(fixture.mutations, ["issue.state.update"])
  assert.equal(record.status, "manual-required")
  assert.equal(record.provider.status, "succeeded")
  assert.equal(record.attempts, 1)
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
    schemaVersion: "2",
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

async function imageFixture(t, options = {}) {
  const { PNG } = await import("pngjs")
  const { createLinearWriteAdapter } = await import("./linear-write-adapter.mjs")
  const f = await createFixture(t, { stage: "part3", stateName: "Testing", ...options })
  const bytes = PNG.sync.write({ width: 3, height: 2, data: Buffer.alloc(24, 255) })
  await fs.writeFile(path.join(f.run.dir, "image.png"), bytes)
  let readFailures = options.imageReadFailures || 0
  const adapter = createLinearWriteAdapter({
    async graphql(_query, { input }) {
      f.mutations.push("comment.create")
      const body = input.body.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/gu, "https://uploads.linear.app/workspace/image/test.png")
      const comment = { id: input.id, body: options.missingImage ? "missing image" : body }
      f.issue.comments.push(comment)
      if (options.responseLost) throw Object.assign(new Error("network timeout"), { code: "ETIMEDOUT" })
      return { commentCreate: { success: true, comment } }
    },
    async readImage() {
      if (readFailures-- > 0) throw new IssuePlatformError({ code: "RATE_LIMITED", retryable: true })
      return options.wrongImage ? Buffer.from("wrong image") : bytes
    },
  })
  Object.assign(f.platforms["primary-issues"].writer, {
    createComment: adapter.createComment,
    verifyCommentImages: adapter.verifyCommentImages,
  })
  f.agentResult = {
    ...resultFor(f, [
      operation("comment.create", "liv-1176:image-comment", { body: "检查通过。", images: [{ filePath: "image.png", caption: "场景" }] }),
      operation("issue.state.update", "liv-1176:image-state", { state: "Ready for Review" }),
    ]),
    schemaVersion: "2",
  }
  f.execute = (executor = f.executor) => executor.execute({ run: f.run, project: f.project, config: { statuses }, agentResult: f.agentResult })
  return f
}

test("image batch validates every file before even an earlier text mutation", async (t) => {
  const f = await imageFixture(t)
  f.agentResult.operations.unshift(operation("comment.create", "liv-1176:earlier-text", { body: "earlier" }))
  f.agentResult.operations[1].payload.images[0].filePath = "../outside.png"
  const result = await f.execute()
  assert.equal(result.status, "manual-required")
  assert.deepEqual(f.mutations, [])
})

test("image batch detects files changing after intents persist before any mutation", async (t) => {
  const f = await imageFixture(t, { checkpoint: async (name, { run }) => {
    if (name === "after-intents-persisted") await fs.writeFile(path.join(run.dir, "image.png"), "changed")
  } })
  assert.equal((await f.execute()).error.code, "CONFLICT")
  assert.deepEqual(f.mutations, [])
})

for (const mode of ["normal", "responseLost", "imageReadFailures", "stateFailures"]) {
  test(`image comments recover ${mode} without repeating commentCreate`, async (t) => {
    const f = await imageFixture(t, { [mode]: 1 })
    const first = await f.execute()
    assert.equal(first.status, ["imageReadFailures", "stateFailures"].includes(mode) ? "retryable" : "completed")
    await fs.unlink(path.join(f.run.dir, "image.png"))
    const restarted = createIssueOperationExecutor({ store: createRunStore(f.rootDir), platforms: f.platforms })
    const replay = await f.execute(restarted)
    assert.equal(replay.status, "completed")
    assert.equal(f.mutations.filter(x => x === "comment.create").length, 1)
    assert.equal(f.issue.comments.length, 1)
    const record = await f.store.getIssueOperation({ platform: "primary-issues", projectKey: "work-automation", issueId: f.run.issueId, type: "comment.create", idempotencyKey: "liv-1176:image-comment" })
    assert.equal(record.intent.images[0].size > 0, true)
    assert.match(record.intent.requestFingerprint, /^[a-f0-9]{64}$/u)
    assert.equal(record.verification.references.length, 1)
  })
}

test("image comment recovers crash after provider write before local success record", async (t) => {
  const f = await imageFixture(t, { checkpoint(name) {
    if (name === "after-provider-write") throw new Error("image process crash")
  } })
  await assert.rejects(f.execute(), /image process crash/u)
  const restarted = createIssueOperationExecutor({ store: createRunStore(f.rootDir), platforms: f.platforms })
  assert.equal((await f.execute(restarted)).status, "completed")
  assert.equal(f.mutations.filter(x => x === "comment.create").length, 1)
})

for (const mode of ["missingImage", "wrongImage"]) {
  test(`image ${mode} retains UUID for manual review without repeating writes`, async (t) => {
    const f = await imageFixture(t, { [mode]: true })
    assert.equal((await f.execute()).status, "manual-required")
    assert.equal((await f.execute()).status, "manual-required")
    assert.deepEqual(f.mutations, ["comment.create"])
  })
}

test("replayed image declarations, order and content cannot change under the same key", async (t) => {
  const f = await imageFixture(t)
  assert.equal((await f.execute()).status, "completed")
  f.agentResult.operations[0].payload.images[0].caption = "changed"
  assert.equal((await f.execute()).error.code, "CONFLICT")
  f.agentResult.operations[0].payload.images[0].caption = "场景"
  await fs.writeFile(path.join(f.run.dir, "image.png"), "changed")
  assert.equal((await f.execute()).error.code, "CONFLICT")
  assert.equal(f.mutations.filter(x => x === "comment.create").length, 1)
})

test("restores a persisted legacy v1 part3 run without changing attachment semantics", async (t) => {
  const f = await createFixture(t, { stage: "part3", stateName: "Testing" })
  const legacyContext = { ...f.run.agentResultContext, allowedOperations: ["attachment.upload", "comment.create", "issue.state.update"] }
  delete legacyContext.schemaVersion
  await f.store.updateRun(f.run, { agentResultContext: legacyContext })
  const run = await f.store.getRunMetadata(f.run.id)
  const result = {
    schemaVersion: "1",
    run: { stage: "part3", projectKey: run.projectKey, parentIssueId: null, allowedOperations: legacyContext.allowedOperations },
    target: legacyContext.target,
    operations: [operation("comment.create", "legacy-v1:review-comment", { body: "旧运行的纯文本审查。" })],
  }
  const restarted = createIssueOperationExecutor({ store: createRunStore(f.rootDir), platforms: f.platforms })
  const request = { run, project: f.project, config: { statuses }, agentResult: result }
  assert.equal((await restarted.execute(request)).status, "completed")
  assert.equal((await restarted.execute(request)).status, "completed")
  assert.deepEqual(f.mutations, ["comment.create"])
  result.operations.push(operation("attachment.upload", "legacy-v1:attachment", { filePath: "old.png" }))
  assert.equal((await restarted.execute(request)).status, "manual-required")
  assert.deepEqual(f.mutations, ["comment.create"])
})
