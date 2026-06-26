import test from "node:test"
import assert from "node:assert/strict"

import {
  checkLinearProjectStatusHealth,
  checkLinearStatusHealth,
  formatProjectStatusHealthBlock,
} from "./status-health.mjs"

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
  ],
}

test("reports missing configured statuses per project team", async () => {
  const health = await checkLinearStatusHealth(baseConfig, {
    linear: fakeLinear([
      "Todo",
      "Needs Clarification",
      "Blocked",
      "Ready for Codex",
      "On Schedule",
      "In Progress",
      "Testing",
    ]),
  })

  assert.equal(health.ok, false)
  assert.equal(health.projects[0].teams[0].missingStatuses.length, 1)
  assert.equal(health.projects[0].teams[0].missingStatuses[0].name, "Ready for Review")
})

test("passes when every configured status exists", async () => {
  const health = await checkLinearStatusHealth(baseConfig, {
    linear: fakeLinear([
      "Todo",
      "Needs Clarification",
      "Blocked",
      "Ready for Codex",
      "On Schedule",
      "In Progress",
      "Testing",
      "Ready for Review",
    ]),
  })

  assert.equal(health.ok, true)
  assert.deepEqual(health.projects[0].teams[0].missingStatuses, [])
})

test("keeps disabled projects out of status health checks", async () => {
  const health = await checkLinearStatusHealth({
    ...baseConfig,
    projects: [{ ...baseConfig.projects[0], enabled: false }],
  })

  assert.equal(health.ok, true)
  assert.equal(health.projects.length, 0)
})

test("captures Linear project read errors without leaking credentials", async () => {
  const health = await checkLinearProjectStatusHealth(baseConfig, baseConfig.projects[0], {
    async listProjectWorkflowStates() {
      throw new Error("Linear GraphQL 错误: project not found")
    },
  })

  assert.equal(health.ok, false)
  assert.match(health.errors[0], /project not found/)
})

test("formats blocking details with missing statuses", async () => {
  const health = await checkLinearProjectStatusHealth(
    baseConfig,
    baseConfig.projects[0],
    fakeLinear(["Todo"]),
  )

  assert.match(formatProjectStatusHealthBlock(health), /Ready for Review/)
  assert.match(formatProjectStatusHealthBlock(health), /workautomation/)
})

function fakeLinear(statusNames) {
  return {
    async listProjectWorkflowStates(projectId) {
      return {
        project: {
          id: projectId,
          name: "work-automation",
          url: "https://linear.app/project-1",
        },
        teams: [
          {
            id: "team-1",
            key: "LIV",
            name: "Livehappy-workhappy",
            workflowStates: statusNames.map((name) => ({ id: name, name, type: "unstarted" })),
          },
        ],
      }
    },
  }
}
