import assert from "node:assert/strict"
import test from "node:test"

import { createLinearWriteAdapter } from "./linear-write-adapter.mjs"

test("creates a child issue with only the preflight-bound inherited fields", async () => {
  const calls = []
  const adapter = createLinearWriteAdapter({
    async graphql(query, variables) {
      calls.push({ query, variables })
      return {
        issueCreate: {
          success: true,
          issue: {
            id: variables.input.id,
            identifier: "LIV-1201",
            title: variables.input.title,
            description: variables.input.description,
            url: "https://linear.app/example/issue/LIV-1201",
            priority: variables.input.priority,
            priorityLabel: "High",
            archivedAt: null,
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            team: { id: variables.input.teamId, key: "LIV", name: "Livehappy-workhappy" },
            project: { id: variables.input.projectId, name: "work-automation" },
            parent: { id: variables.input.parentId, identifier: "LIV-1175" },
          },
        },
      }
    },
  })

  const child = await adapter.createChildIssue({
    target: { platform: "primary-issues", issueId: "issue-1175" },
    idempotencyKey: "issue-1175:split:child-1",
    payload: { title: "实现创建适配器", description: "覆盖创建与写后核对。" },
  }, {
    childIssueId: "a3157519-89ec-4b45-89b0-666e8c298aa8",
    teamId: "team-liv",
    projectId: "project-work-automation",
    priority: 2,
  })

  assert.equal(calls.length, 1)
  assert.match(calls[0].query, /issueCreate/u)
  assert.deepEqual(calls[0].variables, {
    input: {
      id: "a3157519-89ec-4b45-89b0-666e8c298aa8",
      parentId: "issue-1175",
      teamId: "team-liv",
      projectId: "project-work-automation",
      priority: 2,
      title: "实现创建适配器",
      description: "覆盖创建与写后核对。",
    },
  })
  assert.equal(child.id, "a3157519-89ec-4b45-89b0-666e8c298aa8")
  assert.equal(child.parentIssueId, "issue-1175")
  assert.equal(child.team.id, "team-liv")
  assert.equal(child.project.id, "project-work-automation")
  assert.equal(child.priority, 2)
  assert.equal(child.complete, true)
})

test("creates a comment with the server-persisted UUID", async () => {
  const calls = []
  const adapter = createLinearWriteAdapter({
    async graphql(query, variables) {
      calls.push({ query, variables })
      return {
        commentCreate: {
          success: true,
          comment: {
            id: variables.input.id,
            body: variables.input.body,
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
            archivedAt: null,
          },
        },
      }
    },
  })

  const comment = await adapter.createComment({
    target: { platform: "primary-issues", issueId: "issue-1174" },
    idempotencyKey: "issue-1174:part2:comment",
    payload: { body: "Codex Implementation Complete" },
  }, {
    commentId: "9e8d1088-2d64-48c0-8d80-84308a5f6ddb",
  })

  assert.equal(calls.length, 1)
  assert.match(calls[0].query, /commentCreate/u)
  assert.deepEqual(calls[0].variables, {
    input: {
      id: "9e8d1088-2d64-48c0-8d80-84308a5f6ddb",
      issueId: "issue-1174",
      body: "Codex Implementation Complete",
    },
  })
  assert.deepEqual(comment, {
    id: "9e8d1088-2d64-48c0-8d80-84308a5f6ddb",
    body: "Codex Implementation Complete",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
  })
})

test("updates an issue with the preflight-resolved workflow state ID", async () => {
  const calls = []
  const adapter = createLinearWriteAdapter({
    async graphql(query, variables) {
      calls.push({ query, variables })
      return {
        issueUpdate: {
          success: true,
          issue: {
            id: variables.id,
            state: { id: variables.input.stateId, name: "Testing", type: "completed" },
          },
        },
      }
    },
  })

  const state = await adapter.updateIssueState({
    target: { platform: "primary-issues", issueId: "issue-1174" },
    idempotencyKey: "issue-1174:part2:state",
    payload: { state: "Testing" },
  }, {
    stateId: "state-testing",
  })

  assert.equal(calls.length, 1)
  assert.match(calls[0].query, /issueUpdate/u)
  assert.deepEqual(calls[0].variables, {
    id: "issue-1174",
    input: { stateId: "state-testing" },
  })
  assert.deepEqual(state, {
    id: "state-testing",
    name: "Testing",
    type: "completed",
    archivedAt: null,
  })
})

test("classifies provider failures without exposing Linear diagnostics", async () => {
  const adapter = createLinearWriteAdapter({
    async graphql() {
      const error = new Error("Authorization: top-secret-linear-value")
      error.status = 429
      throw error
    },
  })

  await assert.rejects(
    adapter.createComment({
      target: { platform: "primary-issues", issueId: "issue-1174" },
      idempotencyKey: "issue-1174:part2:comment",
      payload: { body: "comment" },
    }, {
      commentId: "9e8d1088-2d64-48c0-8d80-84308a5f6ddb",
    }),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED")
      assert.equal(error.retryable, true)
      assert.equal(error.operation, "comment.create")
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /top-secret/u)
      return true
    },
  )
})
