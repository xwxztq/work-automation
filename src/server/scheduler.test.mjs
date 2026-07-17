import test from "node:test"
import assert from "node:assert/strict"

import {
  createScheduler,
  issueCountsTowardPart2ActiveLimit,
  lostRunCompletionPatch,
  part1EligibleStatuses,
} from "./scheduler.mjs"

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

test("lost runs are marked as reconciled so browsers do not notify", () => {
  assert.deepEqual(lostRunCompletionPatch(true), {
    status: "succeeded",
    completionSource: "reconciled",
    error: undefined,
  })
  assert.equal(lostRunCompletionPatch(false).completionSource, "reconciled")
  assert.equal(lostRunCompletionPatch(false).status, "failed")
})
