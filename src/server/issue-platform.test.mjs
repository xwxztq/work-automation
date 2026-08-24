import assert from "node:assert/strict"
import test from "node:test"

import {
  ISSUE_PLATFORM_ERROR_CODE,
  ISSUE_PLATFORM_OPERATION,
  IssuePlatformError,
  defineIssueReadAdapter,
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

test("defines a platform-independent read adapter for queue and health data", async () => {
  const readAdapter = defineIssueReadAdapter({
    platform: "primary-issues",
    prefix: "bound",
    async readIssue() { return this.prefix },
    async readProject() {},
    async listProjectIssues() {},
    async listProjectWorkflowStates() {},
    async listProjectsWorkflowStates() {},
    async listTeamWorkflowStates() {},
  })

  assert.equal(await readAdapter.readIssue("issue-1"), "bound")
  assert.deepEqual(Object.keys(readAdapter), [
    "platform",
    "readIssue",
    "readProject",
    "listProjectIssues",
    "listProjectWorkflowStates",
    "listProjectsWorkflowStates",
    "listTeamWorkflowStates",
  ])
  assert.equal(Object.isFrozen(readAdapter), true)
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

test("serializes stable platform errors without adapter diagnostics", () => {
  const error = new IssuePlatformError({
    code: ISSUE_PLATFORM_ERROR_CODE.PERMISSION_DENIED,
    operation: ISSUE_PLATFORM_OPERATION.CREATE_COMMENT,
    path: "$.payload.body",
    message: "Authorization: Bearer top-secret-value",
  })

  const serialized = error.toJSON()

  assert.equal(serialized.code, "PERMISSION_DENIED")
  assert.equal(serialized.message, "当前身份不能执行该事项平台操作。")
  assert.equal(serialized.operation, "comment.create")
  assert.equal(serialized.retryable, false)
  assert.doesNotMatch(JSON.stringify(serialized), /top-secret-value/u)
})

test("defines a safe public message for every platform error code", () => {
  const privateValue = "LINEAR_API_KEY=all-codes-private-value-001"

  for (const code of Object.values(ISSUE_PLATFORM_ERROR_CODE)) {
    const error = new IssuePlatformError({ code, message: privateValue })

    assert.equal(Boolean(error.message), true)
    assert.equal(JSON.stringify(error).includes(privateValue), false)
  }
})

test("keeps archived targets and interrupted pagination distinguishable", () => {
  assert.deepEqual(
    new IssuePlatformError({ code: ISSUE_PLATFORM_ERROR_CODE.ARCHIVED }).toJSON(),
    {
      code: "ARCHIVED",
      message: "事项平台目标已归档。",
      operation: null,
      path: "$",
      retryable: false,
    },
  )
  assert.deepEqual(
    new IssuePlatformError({
      code: ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED,
      operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
      retryable: true,
    }).toJSON(),
    {
      code: "PAGINATION_INTERRUPTED",
      message: "事项平台分页读取未完成。",
      operation: "issue.read",
      path: "$",
      retryable: true,
    },
  )
})

test("uses code-owned public messages instead of adapter diagnostics", () => {
  const diagnostics = [
    {
      message: "LINEAR_API_KEY=linear-private-value-001",
      forbidden: ["LINEAR_API_KEY", "linear-private-value-001"],
    },
    {
      message: "apiKey: api-private-value-002",
      forbidden: ["apiKey", "api-private-value-002"],
    },
    {
      message: "api_key='api-private-value-003'",
      forbidden: ["api_key", "api-private-value-003"],
    },
    {
      message: 'provider response: {"client_secret":"oauth-private-value-004"}',
      forbidden: ["client_secret", "oauth-private-value-004"],
    },
  ]

  for (const { message, forbidden } of diagnostics) {
    const error = new IssuePlatformError({
      code: ISSUE_PLATFORM_ERROR_CODE.PERMISSION_DENIED,
      message,
    })
    const publicRepresentations = [
      JSON.stringify(error),
      String(error),
      error.stack || "",
    ].join("\n")

    assert.equal(error.message, "当前身份不能执行该事项平台操作。")
    for (const fragment of forbidden) {
      assert.equal(publicRepresentations.includes(fragment), false)
    }
  }
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
    message: "事项平台暂时不可用。",
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

test("only retains paths from the platform-independent request contract", () => {
  for (const path of [
    "$",
    "$.target",
    "$.target.issueId",
    "$.idempotencyKey",
    "$.payload",
    "$.payload.body",
    "$.payload.include[0]",
  ]) {
    assert.equal(new IssuePlatformError({ path }).toJSON().path, path)
  }

  for (const path of [
    "$.LINEAR_API_KEY",
    "$.apiKey",
    "$.api_key",
    "$.client_secret",
    "$.payload.client_secret",
  ]) {
    const serialized = JSON.stringify(new IssuePlatformError({ path }))

    assert.equal(JSON.parse(serialized).path, "$")
    assert.equal(serialized.includes(path.slice(2)), false)
  }
})
