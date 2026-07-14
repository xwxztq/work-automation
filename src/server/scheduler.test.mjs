import test from "node:test"
import assert from "node:assert/strict"

import { issueCountsTowardPart2ActiveLimit, lostRunCompletionPatch, part1EligibleStatuses } from "./scheduler.mjs"

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
