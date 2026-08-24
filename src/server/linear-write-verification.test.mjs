import test from "node:test"
import assert from "node:assert/strict"

import {
  verifyLinearOperation,
} from "./linear-write-verification.mjs"

test("verifies a comment by its preallocated ID and intended body", () => {
  const verified = verifyLinearOperation({
    operation: {
      type: "comment.create",
      payload: { body: "Codex Implementation Complete" },
    },
    intent: { commentId: "comment-stable-id" },
    issue: {
      comments: [{
        id: "comment-stable-id",
        body: "Codex Implementation Complete",
      }],
    },
  })
  const missing = verifyLinearOperation({
    operation: {
      type: "comment.create",
      payload: { body: "Codex Implementation Complete" },
    },
    intent: { commentId: "comment-stable-id" },
    issue: { comments: [] },
  })

  assert.deepEqual(verified, {
    status: "verified",
    resourceId: "comment-stable-id",
  })
  assert.deepEqual(missing, {
    status: "not-applied",
    resourceId: "comment-stable-id",
  })
})

test("verifies a state update by stable ID and name", () => {
  const operation = {
    type: "issue.state.update",
    payload: { state: "Testing" },
  }
  const intent = {
    state: { id: "state-testing", name: "Testing" },
  }

  assert.deepEqual(
    verifyLinearOperation({
      operation,
      intent,
      issue: { state: { id: "state-testing", name: "Testing" } },
    }),
    { status: "verified", resourceId: "state-testing" },
  )
  assert.deepEqual(
    verifyLinearOperation({
      operation,
      intent,
      issue: { state: { id: "state-schedule", name: "On Schedule" } },
    }),
    { status: "not-applied", resourceId: "state-testing" },
  )
  assert.deepEqual(
    verifyLinearOperation({
      operation,
      intent,
      issue: { state: { id: "state-testing", name: "Renamed Testing" } },
    }),
    { status: "conflict", resourceId: "state-testing" },
  )
})
