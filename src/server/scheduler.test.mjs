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
    async getIssue() {
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
