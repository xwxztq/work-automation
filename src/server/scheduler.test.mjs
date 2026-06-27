import test from "node:test"
import assert from "node:assert/strict"

import { createScheduler } from "./scheduler.mjs"

const baseConfig = {
  linear: { apiKeyEnv: "LINEAR_API_KEY" },
  statuses: {
    todo: "Todo",
    needsClarification: "Needs Clarification",
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
  assert.equal(events.filter((event) => event.type === "project-start").length, 0)
  assert.equal(events.filter((event) => event.type === "linear-status-health-blocked").length, 1)
})
