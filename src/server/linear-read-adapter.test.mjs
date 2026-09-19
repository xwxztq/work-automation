import assert from "node:assert/strict"
import test from "node:test"

import { createLinearReadAdapter } from "./linear-read-adapter.mjs"

test("returns every project issue page as one complete collection", async () => {
  const calls = []
  const pages = new Map([
    [null, projectIssuePage({
      issues: [linearIssue({ id: "issue-1", identifier: "LIV-1" })],
      hasNextPage: true,
      endCursor: "issue-cursor-1",
    })],
    ["issue-cursor-1", projectIssuePage({
      issues: [linearIssue({ id: "issue-2", identifier: "LIV-2" })],
      hasNextPage: false,
      endCursor: "issue-cursor-2",
    })],
  ])
  const adapter = createLinearReadAdapter({
    async graphql(query, variables) {
      calls.push({ query, variables })
      return pages.get(variables.after)
    },
  }, { pageSize: 1 })

  const result = await adapter.listProjectIssues("project-1")

  assert.equal(result.complete, true)
  assert.deepEqual(result.issues.map((issue) => issue.identifier), ["LIV-1", "LIV-2"])
  assert.deepEqual(result.issues.map((issue) => issue.target), [
    { platform: "primary-issues", issueId: "issue-1" },
    { platform: "primary-issues", issueId: "issue-2" },
  ])
  assert.deepEqual(calls.map((call) => call.variables.after), [null, "issue-cursor-1"])
})

test("keeps a complete empty project queue distinct from read failure", async () => {
  const adapter = createLinearReadAdapter({
    async graphql() {
      return projectIssuePage({
        issues: [],
        hasNextPage: false,
        endCursor: null,
      })
    },
  })

  const result = await adapter.listProjectIssues("project-1")

  assert.deepEqual(result.issues, [])
  assert.equal(result.complete, true)
})

test("shares only concurrent reads of the same project queue", async () => {
  let callCount = 0
  const adapter = createLinearReadAdapter({
    async graphql() {
      callCount += 1
      await Promise.resolve()
      return projectIssuePage({ issues: [], hasNextPage: false, endCursor: null })
    },
  })

  const [first, second] = await Promise.all([
    adapter.listProjectIssues("project-1"),
    adapter.listProjectIssues("project-1"),
  ])
  await adapter.listProjectIssues("project-1")

  assert.equal(first, second)
  assert.equal(callCount, 2)
})

test("rejects invalid pagination metadata without returning partial data", async (t) => {
  for (const mode of ["missing-flag", "missing-cursor", "repeated-cursor"]) {
    await t.test(mode, async () => {
      const adapter = createLinearReadAdapter({
        async graphql(_query, variables) {
          if (variables.after === null) {
            const page = projectIssuePage({
              issues: [linearIssue({ id: "issue-1", identifier: "LIV-1" })],
              hasNextPage: true,
              endCursor: mode === "missing-cursor" ? null : "issue-cursor-1",
            })
            if (mode === "missing-flag") {
              delete page.project.issues.pageInfo.hasNextPage
            }
            return page
          }
          return projectIssuePage({
            issues: [linearIssue({ id: "issue-2", identifier: "LIV-2" })],
            hasNextPage: true,
            endCursor: "issue-cursor-1",
          })
        },
      }, { pageSize: 1 })

      await assert.rejects(
        adapter.listProjectIssues("project-1"),
        (error) => error.code === "PAGINATION_INTERRUPTED" && error.retryable === true,
      )
    })
  }
})

test("continues issue comment pages before returning queue context", async () => {
  const secondPageComment = linearComment({
    id: "comment-2",
    body: "用户在第二页补充了验收要求。",
    updatedAt: "2026-08-24T03:00:00.000Z",
  })
  const adapter = createLinearReadAdapter({
    async graphql(query, variables) {
      if (query.includes("LinearReadProjectIssues")) {
        return projectIssuePage({
          issues: [linearIssue({
            id: "issue-1",
            identifier: "LIV-1",
            comments: {
              nodes: [linearComment({ id: "comment-1", body: "AI Triage: READY" })],
              pageInfo: { hasNextPage: true, endCursor: "comment-cursor-1" },
            },
          })],
          hasNextPage: false,
          endCursor: null,
        })
      }

      assert.match(query, /LinearReadIssueComments/u)
      assert.equal(variables.issueId, "issue-1")
      assert.equal(variables.after, "comment-cursor-1")
      return {
        issue: {
          id: "issue-1",
          archivedAt: null,
          comments: {
            nodes: [secondPageComment],
            pageInfo: { hasNextPage: false, endCursor: "comment-cursor-2" },
          },
        },
      }
    },
  }, { pageSize: 1 })

  const result = await adapter.listProjectIssues("project-1")

  assert.equal(result.complete, true)
  assert.equal(result.issues[0].complete, true)
  assert.deepEqual(result.issues[0].comments.map((comment) => comment.id), [
    "comment-1",
    "comment-2",
  ])
  assert.equal(result.issues[0].comments[1].body, secondPageComment.body)
})

test("reads complete issue relations with stable targets and directions", async () => {
  const adapter = createLinearReadAdapter({
    async graphql(query, variables) {
      if (query.includes("query LinearReadIssue(")) {
        return {
          issue: {
            ...linearIssue({ id: "issue-1", identifier: "LIV-1" }),
            relations: {
              nodes: [linearRelation({
                id: "relation-1",
                type: "blocks",
                relatedIssueId: "issue-2",
                relatedIdentifier: "LIV-2",
              })],
              pageInfo: { hasNextPage: true, endCursor: "relation-cursor-1" },
            },
            inverseRelations: {
              nodes: [{
                ...linearRelation({
                  id: "relation-0",
                  type: "blocks",
                  relatedIssueId: "issue-1",
                  relatedIdentifier: "LIV-1",
                }),
                issue: linearIssueReference({
                  id: "issue-0",
                  identifier: "LIV-0",
                }),
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            attachments: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }
      }

      assert.match(query, /LinearReadIssueOutgoingRelations/u)
      assert.equal(variables.after, "relation-cursor-1")
      return {
        issue: {
          id: "issue-1",
          archivedAt: null,
          relations: {
            nodes: [linearRelation({
              id: "relation-2",
              type: "related",
              relatedIssueId: "issue-3",
              relatedIdentifier: "LIV-3",
            })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    },
  }, { pageSize: 1 })

  const issue = await adapter.readIssue("LIV-1")

  assert.equal(issue.complete, true)
  assert.deepEqual(issue.target, { platform: "primary-issues", issueId: "issue-1" })
  assert.deepEqual(issue.relations.map((relation) => ({
    id: relation.id,
    direction: relation.direction,
    target: relation.issue.target,
  })), [
    {
      id: "relation-0",
      direction: "incoming",
      target: { platform: "primary-issues", issueId: "issue-0" },
    },
    {
      id: "relation-1",
      direction: "outgoing",
      target: { platform: "primary-issues", issueId: "issue-2" },
    },
    {
      id: "relation-2",
      direction: "outgoing",
      target: { platform: "primary-issues", issueId: "issue-3" },
    },
  ])
})

test("reports an archived issue without exposing provider data", async () => {
  const adapter = createLinearReadAdapter({
    async graphql() {
      return {
        issue: {
          ...linearIssue({ id: "issue-1", identifier: "LIV-1" }),
          archivedAt: "2026-08-24T04:00:00.000Z",
          providerSecret: "must-not-cross-boundary",
        },
      }
    },
  })

  await assert.rejects(
    adapter.readIssue("LIV-1"),
    (error) => {
      assert.equal(error.code, "ARCHIVED")
      assert.equal(error.retryable, false)
      assert.doesNotMatch(JSON.stringify(error), /must-not-cross-boundary/u)
      return true
    },
  )
})

test("maps permission, missing-target and transient provider failures", async (t) => {
  const cases = [
    {
      name: "permission",
      error: Object.assign(new Error("secret-provider-diagnostic"), { status: 403 }),
      code: "PERMISSION_DENIED",
      retryable: false,
    },
    {
      name: "permission-http-message",
      error: new Error("Linear HTTP 403: secret-provider-diagnostic"),
      code: "PERMISSION_DENIED",
      retryable: false,
    },
    {
      name: "not-found",
      error: new Error("Entity not found: secret-provider-diagnostic"),
      code: "NOT_FOUND",
      retryable: false,
    },
    {
      name: "transient-network",
      error: Object.assign(new Error("secret-provider-diagnostic"), { code: "ETIMEDOUT" }),
      code: "UNAVAILABLE",
      retryable: true,
    },
    {
      name: "transient-http-message",
      error: new Error("Linear HTTP 503: secret-provider-diagnostic"),
      code: "UNAVAILABLE",
      retryable: true,
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const adapter = createLinearReadAdapter({
        async graphql() {
          throw entry.error
        },
      })

      await assert.rejects(
        adapter.readIssue("LIV-1"),
        (error) => {
          assert.equal(error.code, entry.code)
          assert.equal(error.retryable, entry.retryable)
          assert.doesNotMatch(JSON.stringify(error), /secret-provider-diagnostic/u)
          return true
        },
      )
    })
  }
})

test("fails closed with a retryable safe error when a later page is rate limited", async () => {
  const providerError = new Error("Authorization: secret-linear-key rate limit exceeded")
  providerError.status = 429
  const adapter = createLinearReadAdapter({
    async graphql(_query, variables) {
      if (variables.after === null) {
        return projectIssuePage({
          issues: [linearIssue({ id: "issue-1", identifier: "LIV-1" })],
          hasNextPage: true,
          endCursor: "issue-cursor-1",
        })
      }
      throw providerError
    },
  }, { pageSize: 1 })

  await assert.rejects(
    adapter.listProjectIssues("project-1"),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED")
      assert.equal(error.retryable, true)
      assert.equal(error.message, "事项平台请求受到速率限制。")
      assert.doesNotMatch(JSON.stringify(error), /secret-linear-key/u)
      return true
    },
  )
})

test("reads every team and workflow-state page for status health", async () => {
  const adapter = createLinearReadAdapter({
    async graphql(query, variables) {
      if (query.includes("LinearReadProjectTeams")) {
        const secondPage = variables.after === "team-cursor-1"
        return {
          project: {
            id: "project-1",
            name: "work-automation",
            url: "https://linear.example/project-1",
            archivedAt: null,
            teams: {
              nodes: [secondPage
                ? linearTeam({ id: "team-2", key: "MOB" })
                : linearTeam({ id: "team-1", key: "LIV" })],
              pageInfo: secondPage
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: "team-cursor-1" },
            },
          },
        }
      }

      assert.match(query, /LinearReadTeamWorkflowStates/u)
      if (variables.teamId === "team-1" && variables.after === null) {
        return workflowStatePage({
          states: [linearWorkflowState({ id: "state-1", name: "Todo" })],
          hasNextPage: true,
          endCursor: "state-cursor-1",
        })
      }
      if (variables.teamId === "team-1" && variables.after === "state-cursor-1") {
        return workflowStatePage({
          states: [linearWorkflowState({ id: "state-2", name: "Testing" })],
          hasNextPage: false,
          endCursor: null,
        })
      }
      return workflowStatePage({
        states: [linearWorkflowState({ id: "state-3", name: "Ready for Review" })],
        hasNextPage: false,
        endCursor: null,
      })
    },
  }, { pageSize: 1 })

  const [result] = await adapter.listProjectsWorkflowStates(["project-1"])

  assert.equal(result.complete, true)
  assert.equal(result.requestedProjectId, "project-1")
  assert.deepEqual(result.teams.map((team) => ({
    id: team.id,
    states: team.workflowStates.map((state) => `${state.id}:${state.name}`),
  })), [
    { id: "team-1", states: ["state-1:Todo", "state-2:Testing"] },
    { id: "team-2", states: ["state-3:Ready for Review"] },
  ])
})

test("keeps a missing project error scoped to that status-health target", async () => {
  const adapter = createLinearReadAdapter({
    async graphql(query, variables) {
      assert.match(query, /LinearReadProjectTeams/u)
      if (variables.projectId === "missing-project") {
        throw new Error("Entity not found: private-provider-details")
      }
      return {
        project: {
          id: "project-1",
          name: "work-automation",
          url: null,
          archivedAt: null,
          teams: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    },
  })

  const results = await adapter.listProjectsWorkflowStates([
    "missing-project",
    "project-1",
  ])

  assert.equal(results[0].complete, false)
  assert.equal(results[0].error.code, "NOT_FOUND")
  assert.doesNotMatch(JSON.stringify(results[0]), /private-provider-details/u)
  assert.equal(results[1].complete, true)
  assert.equal(results[1].project.id, "project-1")
})

function projectIssuePage({ issues, hasNextPage, endCursor }) {
  return {
    project: {
      id: "project-1",
      name: "work-automation",
      url: "https://linear.example/project-1",
      archivedAt: null,
      issues: {
        nodes: issues,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  }
}

function linearIssue({
  id,
  identifier,
  comments = {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
}) {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    url: `https://linear.example/${identifier}`,
    priority: 0,
    priorityLabel: "No priority",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T01:00:00.000Z",
    archivedAt: null,
    state: { id: "state-todo", name: "Todo", type: "unstarted", archivedAt: null },
    team: { id: "team-1", key: "LIV", name: "Livehappy-workhappy", archivedAt: null },
    project: { id: "project-1", name: "work-automation", url: null, archivedAt: null },
    parent: null,
    assignee: null,
    labels: { nodes: [] },
    comments,
  }
}

function linearComment({
  id,
  body,
  createdAt = "2026-08-24T02:00:00.000Z",
  updatedAt = createdAt,
}) {
  return {
    id,
    body,
    createdAt,
    updatedAt,
    archivedAt: null,
    user: { id: "user-1", name: "Xuan Zhang", email: "xuan@example.test" },
  }
}

function linearRelation({ id, type, relatedIssueId, relatedIdentifier }) {
  return {
    id,
    type,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
    relatedIssue: linearIssueReference({
      id: relatedIssueId,
      identifier: relatedIdentifier,
    }),
  }
}

function linearIssueReference({ id, identifier }) {
  return {
    id,
    identifier,
    title: identifier,
    url: `https://linear.example/${identifier}`,
  }
}

function linearTeam({ id, key }) {
  return {
    id,
    key,
    name: `${key} Team`,
    archivedAt: null,
  }
}

function linearWorkflowState({ id, name }) {
  return {
    id,
    name,
    type: "unstarted",
    archivedAt: null,
  }
}

function workflowStatePage({ states, hasNextPage, endCursor }) {
  return {
    workflowStates: {
      nodes: states,
      pageInfo: { hasNextPage, endCursor },
    },
  }
}
