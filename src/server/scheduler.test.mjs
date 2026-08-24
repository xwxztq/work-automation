import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createScheduler,
  issueCountsTowardPart2ActiveLimit,
  lostRunCompletionPatch,
  part1EligibleStatuses,
} from "./scheduler.mjs"
import { createAgentResultContext } from "./agent-result-runtime.mjs"
import { IssuePlatformError } from "./issue-platform.mjs"
import { createRunStore } from "./run-store.mjs"

const baseConfig = {
  linear: { apiKeyEnv: "LINEAR_API_KEY" },
  statuses: {
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
  },
  projects: [
    {
      key: "workautomation",
      enabled: true,
      repoName: "workautomation",
      linearProjectId: "project-1",
    },
    {
      key: "bridge",
      enabled: true,
      repoName: "bridge",
      linearProjectId: "project-2",
    },
  ],
}

test("blocks a scan globally when Linear status health is not ok", async () => {
  const events = []
  let healthCheckCount = 0
  const scheduler = createScheduler({
    rootDir: process.cwd(),
    configProvider: async () => baseConfig,
    store: {
      async appendEvent(event) {
        events.push(event)
      },
    },
    linearStatusHealthChecker: {
      async check() {
        healthCheckCount += 1
        return {
          ok: false,
          unavailable: false,
          checkedAt: "2026-06-26T00:00:00.000Z",
          requiredStatuses: [],
          errors: [],
          projects: [
            {
              projectKey: "workautomation",
              repoName: "workautomation",
              linearProjectId: "project-1",
              linearProjectName: "work-automation",
              linearProjectUrl: null,
              ok: false,
              teams: [
                {
                  teamId: "team-1",
                  teamKey: "LIV",
                  teamName: "Livehappy-workhappy",
                  existingStatuses: ["Todo"],
                  missingStatuses: [{ key: "readyForReview", label: "Ready for Review", name: "Ready for Review" }],
                  ok: false,
                },
              ],
              errors: [],
            },
            {
              projectKey: "bridge",
              repoName: "bridge",
              linearProjectId: "project-2",
              linearProjectName: "bridge",
              linearProjectUrl: null,
              ok: true,
              teams: [],
              errors: [],
            },
          ],
        }
      },
    },
  })

  const summary = await scheduler.runOnce("both")

  assert.equal(healthCheckCount, 1)
  assert.equal(summary.projects.length, 2)
  assert.match(summary.projects[0].skipped[0], /Ready for Review/)
  assert.match(summary.projects[1].skipped[0], /跳过本轮扫描/)
  assert.deepEqual(summary.projects[0].split, [])
  assert.equal(events.filter((event) => event.type === "project-start").length, 0)
  assert.equal(events.filter((event) => event.type === "linear-status-health-blocked").length, 1)
})

test("does not refresh or start Codex from an incomplete queue result", async () => {
  let readIssueCount = 0
  let codexRunCount = 0
  const scheduler = createScheduler({
    rootDir: process.cwd(),
    configProvider: async () => baseConfig,
    store: {
      async appendEvent() {},
      async listRuns() {
        return []
      },
    },
    linearProvider: () => ({
      async listProjectIssues() {
        return {
          project: { id: "project-1", name: "work-automation" },
          issues: [{
            id: "issue-1",
            identifier: "LIV-1",
            state: { name: "On Schedule" },
            comments: [],
          }],
          complete: false,
        }
      },
      async readIssue() {
        readIssueCount += 1
        throw new Error("不应刷新不完整队列中的事项")
      },
    }),
    linearStatusHealthChecker: {
      async check() {
        return { ok: true, projects: [] }
      },
    },
    codexRunner: async () => {
      codexRunCount += 1
    },
  })

  const summary = await scheduler.runOnce("part2", { projectKey: "workautomation" })

  assert.equal(readIssueCount, 0)
  assert.equal(codexRunCount, 0)
  assert.match(
    summary.projects[0].error || summary.projects[0].skipped[0],
    /读取不完整/u,
  )
})

test("invalid structured results fail without calling any Linear write method", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-scheduler-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootDir, "prompts"), { recursive: true })
  await fs.writeFile(
    path.join(rootDir, "prompts", "part2.global.md"),
    "实现当前事项，并输出结构化结果。\n",
  )

  const issue = {
    id: "issue-1172",
    identifier: "LIV-1172",
    title: "Structured result",
    description: "Validate before writes",
    url: "https://linear.example/LIV-1172",
    priority: 0,
    priorityLabel: "No priority",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T01:00:00.000Z",
    state: { id: "state-schedule", name: "On Schedule", type: "unstarted" },
    team: { id: "team-1", key: "LIV", name: "Livehappy-workhappy" },
    project: { id: "project-1", name: "work-automation" },
    labels: [],
    comments: [],
  }
  let writeCallCount = 0
  const linear = {
    async listProjectIssues() {
      return {
        project: { id: "project-1", name: "work-automation" },
        issues: [issue],
      }
    },
    async readIssue() {
      return issue
    },
    async createComment() {
      writeCallCount += 1
    },
    async updateIssueState() {
      writeCallCount += 1
    },
    async createChildIssue() {
      writeCallCount += 1
    },
    async uploadAttachment() {
      writeCallCount += 1
    },
  }
  const store = createRunStore(rootDir)
  const scheduler = createScheduler({
    rootDir,
    store,
    configProvider: async () => ({
      serverId: "test",
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      codex: {},
      statuses: baseConfig.statuses,
      notifications: {},
      webhook: { enabled: false, urlTemplate: "" },
      projects: [
        {
          key: "work-automation",
          enabled: true,
          repoName: "work-automation",
          linearProjectId: "project-1",
          path: rootDir,
          codexCwd: rootDir,
          branchOrScopePrefix: "main",
          maxActivePart2: 1,
          defaultTests: [],
          extraRules: "无",
        },
      ],
    }),
    linearProvider: () => linear,
    linearStatusHealthChecker: {
      async check() {
        return { ok: true, projects: [] }
      },
    },
    codexRunner: async () => ({
      exitCode: 0,
      status: "failed",
      finalText: '{"secret":"RESULT_SENTINEL"}',
      canceled: false,
      started: true,
      startError: null,
      supervisorPid: 100,
      codexPid: 101,
      error:
        "Agent 结构化结果校验失败: UNKNOWN_OPERATION ($.operations[0].type) 操作类型不受支持。",
      agentResult: undefined,
      agentResultValidation: {
        ok: false,
        error: {
          code: "UNKNOWN_OPERATION",
          path: "$.operations[0].type",
          message: "操作类型不受支持。",
          retryable: false,
        },
      },
      failureKind: "agent-result-invalid",
      failureSummary: "Agent 结构化结果未通过校验",
      failureAction: "检查 final.txt 与 run.json 中的脱敏校验错误。",
      retryableFailure: false,
    }),
  })

  const summary = await scheduler.runOnce("part2")
  const runs = await store.listRuns(10)

  assert.equal(writeCallCount, 0)
  assert.equal(summary.projects[0].part2[0].result, "failed")
  assert.equal(runs[0].status, "failed")
  assert.equal(runs[0].agentResultValidation.error.code, "UNKNOWN_OPERATION")
  assert.doesNotMatch(JSON.stringify(runs[0]), /RESULT_SENTINEL/u)
})

test("executes validated operations before completing and recording the issue", async (t) => {
  const fixture = await createOperationSchedulerFixture(t)
  const scheduler = createScheduler({
    rootDir: fixture.rootDir,
    store: fixture.store,
    configProvider: async () => fixture.config,
    linearProvider: () => fixture.linear,
    linearStatusHealthChecker: {
      async check() {
        return { ok: true, projects: [] }
      },
    },
    codexRunner: async ({ run }) => {
      const agentResult = completedAgentResult(run.agentResultContext, "normal")
      return {
        exitCode: 0,
        status: "succeeded",
        canceled: false,
        started: true,
        startError: null,
        supervisorPid: 100,
        codexPid: 101,
        error: null,
        agentResult,
        agentResultValidation: { ok: true, schemaVersion: "1" },
      }
    },
  })

  const summary = await scheduler.runOnce("part2")
  const [run] = await fixture.store.listRuns(10)
  const processed = await fixture.store.getProcessedIssue(
    "work-automation",
    "part2",
    "issue-1174",
  )

  assert.equal(summary.projects[0].error, undefined)
  assert.equal(summary.projects[0].part2[0].result, "succeeded")
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
  assert.equal(run.status, "succeeded")
  assert.equal(run.operationExecution.status, "completed")
  assert.equal(run.operationExecution.safeTerminal, true)
  assert.equal(processed.stateName, "Testing")
})

test("recovers validated operations from a supervisor-completed run after restart", async (t) => {
  const fixture = await createOperationSchedulerFixture(t)
  let run = await fixture.store.createRun({
    projectKey: "work-automation",
    stage: "part2",
    issue: fixture.issue,
  })
  const agentResultContext = createAgentResultContext({
    stage: "part2",
    projectKey: "work-automation",
    issue: fixture.issue,
  })
  const agentResult = completedAgentResult(agentResultContext, "recovery")
  run = await fixture.store.updateRun(run, {
    status: "succeeded",
    completionSource: "reconciled",
    agentResultContext,
    agentResult,
    agentResultValidation: { ok: true, schemaVersion: "1" },
  })
  let codexRunCount = 0
  const scheduler = createScheduler({
    rootDir: fixture.rootDir,
    store: fixture.store,
    configProvider: async () => fixture.config,
    linearProvider: () => fixture.linear,
    linearStatusHealthChecker: {
      async check() {
        return { ok: true, projects: [] }
      },
    },
    codexRunner: async () => {
      codexRunCount += 1
      throw new Error("不应重新启动 Codex")
    },
  })

  await scheduler.runOnce("part2")
  const recovered = await fixture.store.getRunMetadata(run.id)
  const processed = await fixture.store.getProcessedIssue(
    "work-automation",
    "part2",
    "issue-1174",
  )

  assert.equal(codexRunCount, 0)
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
  assert.equal(recovered.status, "succeeded")
  assert.equal(recovered.operationExecution.status, "completed")
  assert.equal(processed.runId, run.id)
})

test("validates a lost run artifact and executes its operations before starting Codex", async (t) => {
  const fixture = await createOperationSchedulerFixture(t)
  let run = await fixture.store.createRun({
    projectKey: "work-automation",
    stage: "part2",
    issue: fixture.issue,
  })
  const agentResultContext = createAgentResultContext({
    stage: "part2",
    projectKey: "work-automation",
    issue: fixture.issue,
  })
  const agentResult = completedAgentResult(agentResultContext, "lost")
  run = await fixture.store.updateRun(run, {
    agentResultContext,
    createdAt: "2026-08-24T00:00:00.000Z",
  })
  await fs.writeFile(run.finalPath, JSON.stringify(agentResult))
  let codexRunCount = 0
  const scheduler = createScheduler({
    rootDir: fixture.rootDir,
    store: fixture.store,
    configProvider: async () => fixture.config,
    linearProvider: () => fixture.linear,
    linearStatusHealthChecker: {
      async check() {
        return { ok: true, projects: [] }
      },
    },
    codexRunner: async () => {
      codexRunCount += 1
      throw new Error("不应重新启动 Codex")
    },
  })

  await scheduler.runOnce("part2")
  const recovered = await fixture.store.getRunMetadata(run.id)

  assert.equal(codexRunCount, 0)
  assert.equal(recovered.status, "succeeded")
  assert.equal(recovered.operationExecution.status, "completed")
  assert.deepEqual(fixture.mutations, ["comment.create", "issue.state.update"])
})

test("keeps retryable writes unprocessed and resumes them without rerunning Codex", async (t) => {
  const fixture = await createOperationSchedulerFixture(t, { stateFailures: 1 })
  let codexRunCount = 0
  const scheduler = createScheduler({
    rootDir: fixture.rootDir,
    store: fixture.store,
    configProvider: async () => fixture.config,
    linearProvider: () => fixture.linear,
    linearStatusHealthChecker: {
      async check() {
        return { ok: true, projects: [] }
      },
    },
    codexRunner: async ({ run }) => {
      codexRunCount += 1
      const agentResult = completedAgentResult(run.agentResultContext, "retry")
      return {
        exitCode: 0,
        status: "succeeded",
        canceled: false,
        started: true,
        startError: null,
        supervisorPid: 100,
        codexPid: 101,
        error: null,
        agentResult,
        agentResultValidation: { ok: true, schemaVersion: "1" },
      }
    },
  })

  await scheduler.runOnce("part2")
  const [pendingRun] = await fixture.store.listRuns(10)
  const beforeRecovery = await fixture.store.getProcessedIssue(
    "work-automation",
    "part2",
    "issue-1174",
  )
  await scheduler.runOnce("part2")
  const recoveredRun = await fixture.store.getRunMetadata(pendingRun.id)
  const afterRecovery = await fixture.store.getProcessedIssue(
    "work-automation",
    "part2",
    "issue-1174",
  )

  assert.equal(beforeRecovery, null)
  assert.equal(codexRunCount, 1)
  assert.deepEqual(fixture.mutations, [
    "comment.create",
    "issue.state.update",
    "issue.state.update",
  ])
  assert.equal(recoveredRun.status, "succeeded")
  assert.equal(recoveredRun.operationExecution.status, "completed")
  assert.equal(afterRecovery.runId, pendingRun.id)
})

test("does not create a second run while operation recovery is still retryable", async (t) => {
  const fixture = await createOperationSchedulerFixture(t, { stateFailures: 3 })
  let codexRunCount = 0
  const scheduler = createScheduler({
    rootDir: fixture.rootDir,
    store: fixture.store,
    configProvider: async () => fixture.config,
    linearProvider: () => fixture.linear,
    linearStatusHealthChecker: {
      async check() {
        return { ok: true, projects: [] }
      },
    },
    codexRunner: async ({ run }) => {
      codexRunCount += 1
      const agentResult = completedAgentResult(run.agentResultContext, "long-retry")
      return {
        exitCode: 0,
        status: "succeeded",
        canceled: false,
        started: true,
        startError: null,
        supervisorPid: 100,
        codexPid: 101,
        error: null,
        agentResult,
        agentResultValidation: { ok: true, schemaVersion: "1" },
      }
    },
  })

  await scheduler.runOnce("part2")
  await scheduler.runOnce("part2")
  const runs = await fixture.store.listRuns(10)

  assert.equal(codexRunCount, 1)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].operationExecution.status, "retryable")
  assert.deepEqual(fixture.mutations, [
    "comment.create",
    "issue.state.update",
    "issue.state.update",
  ])
})

const config = {
  statuses: {
    inProgress: "In Progress",
  },
}

test("part1 eligible statuses include too large for retriage", () => {
  const statuses = part1EligibleStatuses({
    statuses: {
      todo: "Todo",
      needsClarification: "Needs Clarification",
      tooLarge: "Too Large",
      blocked: "Blocked",
    },
  })

  assert.deepEqual([...statuses], ["Todo", "Needs Clarification", "Too Large", "Blocked"])
})

test("part2 active limit counts handoff-driven implementation issues", () => {
  const issue = {
    state: { name: "In Progress" },
    comments: [
      {
        id: "comment-1",
        createdAt: "2026-06-26T01:00:00.000Z",
        body: "Codex Handoff\n\n已认领并开始实现。",
      },
    ],
  }

  assert.equal(issueCountsTowardPart2ActiveLimit(issue, config), true)
})

test("part2 active limit ignores split parents moved to In Progress", () => {
  const issue = {
    state: { name: "In Progress" },
    comments: [
      {
        id: "comment-1",
        createdAt: "2026-06-26T01:00:00.000Z",
        body: "Codex Handoff\n\n旧的实现认领。",
      },
      {
        id: "comment-2",
        createdAt: "2026-06-26T02:00:00.000Z",
        body: "Codex Split Complete\n\n覆盖清单:\n1. ...",
      },
    ],
  }

  assert.equal(issueCountsTowardPart2ActiveLimit(issue, config), false)
})

test("part2 active limit ignores in-progress issues without implementation handoff", () => {
  const issue = {
    state: { name: "In Progress" },
    comments: [
      {
        id: "comment-1",
        createdAt: "2026-06-26T02:00:00.000Z",
        body: "Codex Split Complete\n\n覆盖清单:\n1. ...",
      },
    ],
  }

  assert.equal(issueCountsTowardPart2ActiveLimit(issue, config), false)
})

test("lost runs only succeed when their final artifact passes the bound parser", () => {
  const context = createAgentResultContext({
    stage: "part2",
    projectKey: "work-automation",
    issue: { id: "issue-1172" },
  })
  const value = {
    schemaVersion: "1",
    run: {
      stage: context.stage,
      projectKey: context.projectKey,
      parentIssueId: context.parentIssueId,
      allowedOperations: context.allowedOperations,
    },
    target: context.target,
    operations: [],
  }

  const valid = lostRunCompletionPatch(JSON.stringify(value), context)
  const missing = lostRunCompletionPatch("", context)
  const wrongTarget = lostRunCompletionPatch(
    JSON.stringify({
      ...value,
      target: { ...value.target, issueId: "other-issue" },
    }),
    context,
  )

  assert.equal(valid.status, "succeeded")
  assert.equal(valid.completionSource, "reconciled")
  assert.deepEqual(valid.agentResult, value)
  assert.equal(missing.status, "failed")
  assert.equal(missing.agentResultValidation.error.code, "INVALID_JSON")
  assert.equal(wrongTarget.status, "failed")
  assert.equal(wrongTarget.agentResultValidation.error.code, "TARGET_MISMATCH")
})

async function createOperationSchedulerFixture(t, { stateFailures = 0 } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-scheduler-write-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootDir, "prompts"), { recursive: true })
  await fs.writeFile(
    path.join(rootDir, "prompts", "part2.global.md"),
    "实现当前事项，并输出结构化结果。\n",
  )
  const states = [
    { id: "state-schedule", name: "On Schedule", type: "unstarted", archivedAt: null },
    { id: "state-testing", name: "Testing", type: "completed", archivedAt: null },
    { id: "state-clarification", name: "Needs Clarification", type: "unstarted", archivedAt: null },
    { id: "state-blocked", name: "Blocked", type: "canceled", archivedAt: null },
  ]
  const issue = {
    id: "issue-1174",
    identifier: "LIV-1174",
    title: "Controlled writes",
    description: "Execute operations",
    target: { platform: "primary-issues", issueId: "issue-1174" },
    priority: 0,
    priorityLabel: "No priority",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T01:00:00.000Z",
    state: { ...states[0] },
    team: { id: "team-1", key: "LIV", name: "Livehappy-workhappy" },
    project: { id: "project-1", name: "work-automation" },
    labels: [],
    comments: [],
    complete: true,
  }
  const mutations = []
  let remainingStateFailures = stateFailures
  const linear = {
    platform: "primary-issues",
    async listProjectIssues() {
      return {
        project: { id: "project-1", name: "work-automation" },
        issues: [structuredClone(issue)],
        complete: true,
      }
    },
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
      return structuredClone(states)
    },
  }
  linear.operationWriter = {
    platform: "primary-issues",
    supportedOperations: ["comment.create", "issue.state.update"],
    async createComment(request, { commentId }) {
      mutations.push("comment.create")
      const comment = {
        id: commentId,
        body: request.payload.body,
        createdAt: "2026-08-24T02:00:00.000Z",
        updatedAt: "2026-08-24T02:00:00.000Z",
        archivedAt: null,
      }
      issue.comments.push(comment)
      issue.updatedAt = "2026-08-24T02:00:00.000Z"
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
      issue.state = { ...states.find((state) => state.id === stateId) }
      issue.updatedAt = "2026-08-24T03:00:00.000Z"
      return structuredClone(issue.state)
    },
  }
  const config = {
    serverId: "test",
    linear: { apiKeyEnv: "LINEAR_API_KEY" },
    codex: {},
    statuses: baseConfig.statuses,
    notifications: {},
    webhook: { enabled: false, urlTemplate: "" },
    projects: [{
      key: "work-automation",
      enabled: true,
      repoName: "work-automation",
      linearProjectId: "project-1",
      path: rootDir,
      codexCwd: rootDir,
      branchOrScopePrefix: "main",
      maxActivePart2: 1,
      defaultTests: [],
      extraRules: "无",
    }],
  }
  return {
    config,
    issue,
    linear,
    mutations,
    rootDir,
    store: createRunStore(rootDir),
  }
}

function completedAgentResult(context, suffix) {
  return {
    schemaVersion: "1",
    run: {
      stage: context.stage,
      projectKey: context.projectKey,
      parentIssueId: context.parentIssueId,
      allowedOperations: context.allowedOperations,
    },
    target: context.target,
    operations: [
      {
        type: "comment.create",
        idempotencyKey: `issue-1174:part2:${suffix}:comment`,
        payload: { body: "Codex Implementation Complete" },
      },
      {
        type: "issue.state.update",
        idempotencyKey: `issue-1174:part2:${suffix}:state`,
        payload: { state: "Testing" },
      },
    ],
  }
}
