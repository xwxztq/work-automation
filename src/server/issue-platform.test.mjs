import assert from "node:assert/strict"
import test from "node:test"

import {
  ISSUE_PLATFORM_ERROR_CODE,
  ISSUE_PLATFORM_OPERATION,
  IssuePlatformError,
  defineIssuePlatform,
  normalizeIssuePlatformError,
} from "./issue-platform.mjs"

function adapter(overrides = {}) {
  return {
    platform: "primary-issues",
    prefix: "bound",
    async readIssue() {
      return this.prefix
    },
    async createComment() {},
    async updateIssueState() {},
    async createChildIssue() {},
    async uploadAttachment() {},
    ...overrides,
  }
}

test("defines a platform-independent adapter with bound methods", async () => {
  const platform = defineIssuePlatform(adapter())

  assert.equal(platform.platform, "primary-issues")
  assert.equal(await platform.readIssue({}), "bound")
  assert.deepEqual(Object.keys(platform), [
    "platform",
    "readIssue",
    "createComment",
    "updateIssueState",
    "createChildIssue",
    "uploadAttachment",
  ])
  assert.equal(Object.isFrozen(platform), true)
})

test("rejects adapters that omit a required operation", () => {
  const input = adapter()
  delete input.uploadAttachment

  assert.throws(() => defineIssuePlatform(input), /uploadAttachment/u)
})

test("rejects non-string and provider-shaped adapter identifiers", () => {
  assert.throws(() => defineIssuePlatform(adapter({ platform: 123 })), /platform/u)
  assert.throws(
    () => defineIssuePlatform(adapter({ platform: "Primary Issues" })),
    /platform/u,
  )
})

test("serializes stable platform errors and redacts credential-shaped text", () => {
  const error = new IssuePlatformError({
    code: ISSUE_PLATFORM_ERROR_CODE.PERMISSION_DENIED,
    operation: ISSUE_PLATFORM_OPERATION.CREATE_COMMENT,
    path: "$.payload.body",
    message: "Authorization: Bearer top-secret-value",
  })

  const serialized = error.toJSON()

  assert.equal(serialized.code, "PERMISSION_DENIED")
  assert.equal(serialized.operation, "comment.create")
  assert.equal(serialized.retryable, false)
  assert.doesNotMatch(JSON.stringify(serialized), /top-secret-value/u)
})

test("does not expose raw provider errors across the adapter boundary", () => {
  const normalized = normalizeIssuePlatformError(
    new Error("provider response contained private-value-123"),
    {
      operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
      code: ISSUE_PLATFORM_ERROR_CODE.UNAVAILABLE,
      retryable: true,
    },
  )

  assert.deepEqual(normalized, {
    code: "UNAVAILABLE",
    message: "事项平台操作失败。",
    operation: "issue.read",
    path: "$",
    retryable: true,
  })
  assert.doesNotMatch(JSON.stringify(normalized), /private-value-123/u)
})

test("drops non-JSON paths from public platform errors", () => {
  const error = new IssuePlatformError({
    path: "Authorization: Bearer private-path-value",
  })

  assert.equal(error.toJSON().path, "$")
  assert.doesNotMatch(JSON.stringify(error), /private-path-value/u)
})
