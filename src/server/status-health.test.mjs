import test from "node:test"
import assert from "node:assert/strict"

import {
  checkLinearProjectStatusHealth,
  checkLinearStatusHealth,
  createLinearStatusHealthChecker,
  formatProjectStatusHealthBlock,
} from "./status-health.mjs"

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
  ],
}

test("reports missing configured statuses per project team", async () => {
  const health = await checkLinearStatusHealth(baseConfig, {
    linear: fakeLinear([
      "Todo",
      "Needs Clarification",
      "Too Large",
      "Needs Splitting",
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
      "Too Large",
      "Needs Splitting",
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

test("checks enabled projects through one global batch call", async () => {
  const calls = []
  const health = await checkLinearStatusHealth(
    {
      ...baseConfig,
      projects: [
        baseConfig.projects[0],
        {
          ...baseConfig.projects[0],
          key: "bridge",
          repoName: "bridge",
          linearProjectId: "project-2",
        },
      ],
    },
    {
      linear: {
        async listProjectsWorkflowStates(projectIds) {
          calls.push(projectIds)
          return projectIds.map((projectId) => fakeProjectWorkflowStates(projectId, allRequiredStatusNames()))
        },
      },
    },
  )

  assert.equal(health.ok, true)
  assert.deepEqual(calls, [["project-1", "project-2"]])
  assert.equal(health.projects.length, 2)
})

test("deduplicates repeated Linear project ids in status health checks", async () => {
  const calls = []
  const health = await checkLinearStatusHealth(
    {
      ...baseConfig,
      projects: [
        baseConfig.projects[0],
        {
          ...baseConfig.projects[0],
          key: "workautomation-copy",
          repoName: "workautomation-copy",
        },
      ],
    },
    {
      linear: {
        async listProjectsWorkflowStates(projectIds) {
          calls.push(projectIds)
          return projectIds.map((projectId) => fakeProjectWorkflowStates(projectId, allRequiredStatusNames()))
        },
      },
    },
  )

  assert.equal(health.ok, true)
  assert.deepEqual(calls, [["project-1"]])
  assert.equal(health.projects.length, 2)
})

test("maps batched workflow state results by requested project slug", async () => {
  const health = await checkLinearStatusHealth(
    {
      ...baseConfig,
      projects: [
        {
          ...baseConfig.projects[0],
          linearProjectId: "bridge-21b961fe9da9",
        },
      ],
    },
    {
      linear: {
        async listProjectsWorkflowStates(projectIds) {
          return projectIds.map((projectId) => ({
            requestedProjectId: projectId,
            ...fakeProjectWorkflowStates("real-linear-project-uuid", allRequiredStatusNames()),
          }))
        },
      },
    },
  )

  assert.equal(health.ok, true)
  assert.equal(health.projects[0].linearProjectId, "bridge-21b961fe9da9")
  assert.equal(health.projects[0].linearProjectName, "work-automation")
})

test("builds status health from the paginated read adapter client boundary", async () => {
  const health = await checkLinearStatusHealth(baseConfig, {
    linearClient: {
      async graphql(query) {
        if (query.includes("LinearReadProjectTeams")) {
          return {
            project: {
              id: "project-1",
              name: "work-automation",
              url: "https://linear.example/project-1",
              archivedAt: null,
              teams: {
                nodes: [{ id: "team-1", key: "LIV", name: "Livehappy-workhappy", archivedAt: null }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }
        }
        return {
          workflowStates: {
            nodes: allRequiredStatusNames().map((name) => ({
              id: `state-${name}`,
              name,
              type: "unstarted",
              archivedAt: null,
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      },
    },
  })

  assert.equal(health.ok, true)
  assert.deepEqual(health.projects[0].teams[0].existingStatuses, allRequiredStatusNames().sort())
})

test("blocks status health when an adapter result is incomplete", async () => {
  const health = await checkLinearStatusHealth(baseConfig, {
    linear: {
      async listProjectsWorkflowStates() {
        return [{
          requestedProjectId: "project-1",
          ...fakeProjectWorkflowStates("project-1", allRequiredStatusNames()),
          complete: false,
        }]
      },
    },
  })

  assert.equal(health.ok, false)
  assert.match(health.projects[0].errors[0], /读取不完整/u)
})

test("preserves a safe structured missing-project error in health output", async () => {
  const health = await checkLinearStatusHealth(baseConfig, {
    linear: {
      async listProjectsWorkflowStates() {
        return [{
          requestedProjectId: "project-1",
          project: { id: "project-1", name: "", url: null },
          teams: [],
          complete: false,
          error: {
            code: "NOT_FOUND",
            message: "private-provider-details",
            operation: "issue.read",
            path: "$",
            retryable: false,
          },
        }]
      },
    },
  })

  assert.equal(health.ok, false)
  assert.equal(health.projects[0].readError.code, "NOT_FOUND")
  assert.equal(health.projects[0].readError.message, "事项平台目标不存在。")
  assert.doesNotMatch(JSON.stringify(health), /private-provider-details/u)
})

test("marks transient read failures as unavailable and retryable", async () => {
  const failure = Object.assign(new Error("private-network-details"), {
    code: "UNAVAILABLE",
    retryable: true,
  })
  const health = await checkLinearStatusHealth(baseConfig, {
    linear: {
      async listProjectsWorkflowStates() {
        throw failure
      },
    },
  })

  assert.equal(health.ok, false)
  assert.equal(health.unavailable, true)
  assert.equal(health.projects[0].readError.code, "UNAVAILABLE")
  assert.equal(health.projects[0].readError.retryable, true)
  assert.doesNotMatch(JSON.stringify(health), /private-network-details/u)
})

test("caches status health checks for repeated callers", async () => {
  let callCount = 0
  const checker = createLinearStatusHealthChecker({ ttlMs: 60_000 })
  const linear = {
    async listProjectsWorkflowStates(projectIds) {
      callCount += 1
      return projectIds.map((projectId) => fakeProjectWorkflowStates(projectId, allRequiredStatusNames()))
    },
  }

  await checker.check(baseConfig, { linear })
  await checker.check(baseConfig, { linear })
  await checker.check(baseConfig, { linear, force: true })

  assert.equal(callCount, 2)
})

test("captures Linear project read errors without leaking credentials", async () => {
  const health = await checkLinearProjectStatusHealth(baseConfig, baseConfig.projects[0], {
    async listProjectWorkflowStates() {
      throw new Error("Linear GraphQL 错误: project not found apiKey=private-value")
    },
  })

  assert.equal(health.ok, false)
  assert.equal(health.readError.code, "OPERATION_FAILED")
  assert.match(health.errors[0], /事项平台操作失败/u)
  assert.doesNotMatch(JSON.stringify(health), /private-value/u)
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
      return fakeProjectWorkflowStates(projectId, statusNames)
    },
  }
}

function fakeProjectWorkflowStates(projectId, statusNames) {
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
}

function allRequiredStatusNames() {
  return [
    "Todo",
    "Needs Clarification",
    "Too Large",
    "Needs Splitting",
    "Blocked",
    "Ready for Codex",
    "On Schedule",
    "In Progress",
    "Testing",
    "Ready for Review",
  ]
}
