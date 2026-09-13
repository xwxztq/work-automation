import assert from "node:assert/strict"
import test from "node:test"

import {
  AGENT_RESULT_ERROR_CODE,
  AGENT_RESULT_OPERATION,
  parseAgentResult,
  validateAgentResult,
} from "./agent-result-protocol.mjs"
import {
  AGENT_RESULT_ALLOWED_OPERATIONS_BY_STAGE,
  agentResultRunPatch,
  buildAgentResultOutputSchema,
  createAgentResultContext,
  evaluateAgentResult,
} from "./agent-result-runtime.mjs"

const ALL_OPERATIONS = Object.values(AGENT_RESULT_OPERATION)

function validationContext(overrides = {}) {
  return {
    stage: "part2",
    projectKey: "work-automation",
    parentIssueId: "issue-parent",
    target: {
      platform: "primary-issues",
      issueId: "issue-1171",
    },
    allowedOperations: [...ALL_OPERATIONS],
    ...overrides,
  }
}

function envelope(overrides = {}) {
  return {
    schemaVersion: "1",
    run: {
      stage: "part2",
      projectKey: "work-automation",
      parentIssueId: "issue-parent",
      allowedOperations: [AGENT_RESULT_OPERATION.READ_ISSUE],
    },
    target: {
      platform: "primary-issues",
      issueId: "issue-1171",
    },
    operations: [
      {
        type: AGENT_RESULT_OPERATION.READ_ISSUE,
        idempotencyKey: "issue-1171:part2:read",
        payload: { include: ["comments"] },
      },
    ],
    ...overrides,
  }
}

for (const stage of ["part1", "split", "part2", "part3"]) {
  test("validates " + stage + " with the shared v1 envelope", () => {
    const context = validationContext({ stage })
    const input = envelope({
      run: {
        ...envelope().run,
        stage,
      },
    })

    const result = validateAgentResult(input, context)

    assert.equal(result.ok, true)
    assert.equal(result.value?.schemaVersion, "1")
    assert.equal(result.value?.run.stage, stage)
  })
}

test("parses exact JSON without relying on free-text extraction", () => {
  const result = parseAgentResult(JSON.stringify(envelope()), validationContext())

  assert.equal(result.ok, true)
  assert.deepEqual(result.value?.operations[0].payload, { include: ["comments"] })

  const fenced = parseAgentResult(
    "```json\n" + JSON.stringify(envelope()) + "\n```",
    validationContext(),
  )
  assert.equal(fenced.ok, false)
  assert.equal(fenced.error?.code, AGENT_RESULT_ERROR_CODE.INVALID_JSON)
})

test("accepts a bound no-op result without a parent issue", () => {
  const context = validationContext({
    parentIssueId: null,
    allowedOperations: [],
  })
  const input = envelope({
    run: {
      ...envelope().run,
      parentIssueId: null,
      allowedOperations: [],
    },
    operations: [],
  })

  const result = validateAgentResult(input, context)

  assert.equal(result.ok, true)
  assert.equal(result.value?.run.parentIssueId, null)
  assert.deepEqual(result.value?.operations, [])
})

test("normalizes every platform-independent operation", () => {
  const operations = [
    {
      type: AGENT_RESULT_OPERATION.READ_ISSUE,
      idempotencyKey: "issue-1171:read:001",
      payload: { include: ["comments", "attachments", "relations"] },
    },
    {
      type: AGENT_RESULT_OPERATION.CREATE_COMMENT,
      idempotencyKey: "issue-1171:comment:001",
      payload: { body: "实现完成。" },
    },
    {
      type: AGENT_RESULT_OPERATION.UPDATE_ISSUE_STATE,
      idempotencyKey: "issue-1171:state:001",
      payload: { state: "Testing" },
    },
    {
      type: AGENT_RESULT_OPERATION.CREATE_CHILD_ISSUE,
      idempotencyKey: "issue-1171:child:001",
      payload: { title: "子事项", description: "范围说明" },
    },
    {
      type: AGENT_RESULT_OPERATION.UPLOAD_ATTACHMENT,
      idempotencyKey: "issue-1171:attachment:001",
      payload: {
        filePath: "/tmp/review/summary.md",
        filename: "summary.md",
        contentType: "text/markdown",
        title: "Review 摘要",
      },
    },
  ]
  const input = envelope({
    run: {
      ...envelope().run,
      allowedOperations: [...ALL_OPERATIONS],
    },
    operations,
  })

  const result = validateAgentResult(input, validationContext())

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.value?.operations.map((operation) => operation.type),
    ALL_OPERATIONS,
  )
  assert.equal(result.value?.operations[4].payload.filename, "summary.md")
})

test("rejects missing fields with a stable path", () => {
  const input = envelope()
  delete input.operations

  const result = validateAgentResult(input, validationContext())

  assert.deepEqual(result.error, {
    code: "MISSING_FIELD",
    path: "$.operations",
    message: "缺少协议必填字段。",
    retryable: false,
  })
})

test("rejects missing fields in operation payloads", () => {
  const cases = [
    [AGENT_RESULT_OPERATION.CREATE_COMMENT, "$.operations[0].payload.body"],
    [AGENT_RESULT_OPERATION.UPDATE_ISSUE_STATE, "$.operations[0].payload.state"],
    [AGENT_RESULT_OPERATION.CREATE_CHILD_ISSUE, "$.operations[0].payload.title"],
    [AGENT_RESULT_OPERATION.UPLOAD_ATTACHMENT, "$.operations[0].payload.filePath"],
  ]

  for (const [type, expectedPath] of cases) {
    const input = envelope({
      run: {
        ...envelope().run,
        allowedOperations: [type],
      },
      operations: [
        {
          type,
          idempotencyKey: "issue-1171:missing:001",
          payload: {},
        },
      ],
    })
    const result = validateAgentResult(input, validationContext())
    assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.MISSING_FIELD)
    assert.equal(result.error?.path, expectedPath)
  }
})

test("rejects unknown schema versions without echoing the supplied value", () => {
  const privateValue = "private-version-value-123"
  const result = validateAgentResult(
    envelope({ schemaVersion: privateValue }),
    validationContext(),
  )

  assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.UNKNOWN_VERSION)
  assert.equal(result.error?.path, "$.schemaVersion")
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue, "u"))
})

test("rejects unknown operations even when the service grants other operations", () => {
  const input = envelope({
    operations: [
      {
        type: "issue.destroy",
        idempotencyKey: "issue-1171:unknown:001",
        payload: {},
      },
    ],
  })

  const result = validateAgentResult(input, validationContext())

  assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.UNKNOWN_OPERATION)
  assert.equal(result.error?.path, "$.operations[0].type")
})

test("rejects permissions that were not granted by the service", () => {
  const input = envelope({
    run: {
      ...envelope().run,
      allowedOperations: [AGENT_RESULT_OPERATION.CREATE_COMMENT],
    },
    operations: [],
  })
  const context = validationContext({
    allowedOperations: [AGENT_RESULT_OPERATION.READ_ISSUE],
  })

  const result = validateAgentResult(input, context)

  assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.OPERATION_NOT_ALLOWED)
  assert.equal(result.error?.path, "$.run.allowedOperations[0]")
})

test("rejects operations omitted from the envelope permission declaration", () => {
  const input = envelope({
    operations: [
      {
        type: AGENT_RESULT_OPERATION.CREATE_COMMENT,
        idempotencyKey: "issue-1171:comment:002",
        payload: { body: "未声明的操作" },
      },
    ],
  })

  const result = validateAgentResult(input, validationContext())

  assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.OPERATION_NOT_ALLOWED)
  assert.equal(result.error?.path, "$.operations[0].type")
})

test("rejects stage, project, parent, and target mismatches", () => {
  const cases = [
    {
      expectedCode: AGENT_RESULT_ERROR_CODE.STAGE_MISMATCH,
      input: envelope({ run: { ...envelope().run, stage: "part3" } }),
    },
    {
      expectedCode: AGENT_RESULT_ERROR_CODE.PROJECT_MISMATCH,
      input: envelope({ run: { ...envelope().run, projectKey: "other-project" } }),
    },
    {
      expectedCode: AGENT_RESULT_ERROR_CODE.PARENT_ISSUE_MISMATCH,
      input: envelope({ run: { ...envelope().run, parentIssueId: "other-parent" } }),
    },
    {
      expectedCode: AGENT_RESULT_ERROR_CODE.TARGET_MISMATCH,
      input: envelope({
        target: { ...envelope().target, issueId: "other-issue" },
      }),
    },
  ]

  for (const item of cases) {
    const result = validateAgentResult(item.input, validationContext())
    assert.equal(result.error?.code, item.expectedCode)
  }
})

test("rejects invalid and duplicate idempotency keys", () => {
  const invalidKey = envelope()
  invalidKey.operations[0].idempotencyKey = "short"
  assert.equal(
    validateAgentResult(invalidKey, validationContext()).error?.code,
    AGENT_RESULT_ERROR_CODE.INVALID_IDEMPOTENCY_KEY,
  )

  const duplicateKey = "issue-1171:duplicate:001"
  const duplicate = envelope({
    operations: [
      {
        type: AGENT_RESULT_OPERATION.READ_ISSUE,
        idempotencyKey: duplicateKey,
        payload: {},
      },
      {
        type: AGENT_RESULT_OPERATION.READ_ISSUE,
        idempotencyKey: duplicateKey,
        payload: {},
      },
    ],
  })
  assert.equal(
    validateAgentResult(duplicate, validationContext()).error?.code,
    AGENT_RESULT_ERROR_CODE.DUPLICATE_IDEMPOTENCY_KEY,
  )
})

test("accepts ASCII idempotency keys and rejects Unicode case-folding lookalikes", () => {
  for (const key of ["Kaaaaaaa", "SAAAAAAA", "issue-1171:ASCII:001"]) {
    const input = envelope()
    input.operations[0].idempotencyKey = key

    assert.equal(validateAgentResult(input, validationContext()).ok, true)
  }

  for (const key of ["Kaaaaaaa", "ſaaaaaaa"]) {
    const input = envelope()
    input.operations[0].idempotencyKey = key

    const result = validateAgentResult(input, validationContext())

    assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.INVALID_IDEMPOTENCY_KEY)
    assert.equal(result.error?.path, "$.operations[0].idempotencyKey")
  }
})

test("accepts explicit v1 extensions and rejects undeclared fields", () => {
  const compatible = envelope({
    extensions: { producer: { build: 7 } },
    operations: [
      {
        ...envelope().operations[0],
        extensions: { trace: ["generated"] },
        payload: {
          include: ["comments"],
          extensions: { cache: "prefer" },
        },
      },
    ],
  })

  const accepted = validateAgentResult(compatible, validationContext())

  assert.equal(accepted.ok, true)
  assert.equal(accepted.value?.extensions.producer.build, 7)
  assert.equal(accepted.value?.operations[0].payload.extensions.cache, "prefer")

  const incompatible = envelope({ unexpected: true })
  const rejected = validateAgentResult(incompatible, validationContext())
  assert.equal(rejected.error?.code, AGENT_RESULT_ERROR_CODE.UNKNOWN_FIELD)
  assert.equal(rejected.error?.path, "$")
})

test("does not include input-controlled field names in validation errors", () => {
  const rootField = "LINEAR_API_KEY_private-field-123"
  const rootInput = envelope()
  rootInput[rootField] = true

  const rootResult = validateAgentResult(rootInput, validationContext())

  assert.equal(rootResult.error?.code, AGENT_RESULT_ERROR_CODE.UNKNOWN_FIELD)
  assert.equal(rootResult.error?.path, "$")
  assert.equal(JSON.stringify(rootResult).includes(rootField), false)

  const payloadField = "client_secret_private-field-456"
  const payloadInput = envelope()
  payloadInput.operations[0].payload[payloadField] = true

  const payloadResult = validateAgentResult(payloadInput, validationContext())

  assert.equal(payloadResult.error?.code, AGENT_RESULT_ERROR_CODE.UNKNOWN_FIELD)
  assert.equal(payloadResult.error?.path, "$.operations[0].payload")
  assert.equal(JSON.stringify(payloadResult).includes(payloadField), false)
})

test("does not include extension keys in validation error paths", () => {
  const privateField = "api_key_private-field-789"
  const extensions = {}
  extensions[privateField] = extensions

  const result = validateAgentResult(envelope({ extensions }), validationContext())

  assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.INVALID_FIELD)
  assert.equal(result.error?.path, "$.extensions")
  assert.equal(JSON.stringify(result).includes(privateField), false)
})

test("rejects extensions that exceed the compatibility depth limit", () => {
  let extensions = {}
  let cursor = extensions
  for (let index = 0; index < 34; index += 1) {
    cursor.child = {}
    cursor = cursor.child
  }

  const result = validateAgentResult(envelope({ extensions }), validationContext())

  assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.INVALID_FIELD)
  assert.match(result.error?.message || "", /嵌套过深/u)
})

test("rejects malformed JSON without returning the raw text", () => {
  const privateValue = "private-json-value-456"
  const result = parseAgentResult("{" + privateValue, validationContext())

  assert.equal(result.error?.code, AGENT_RESULT_ERROR_CODE.INVALID_JSON)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue, "u"))
})

test("builds immutable stage permissions and a target-bound output schema", () => {
  const context = createAgentResultContext({
    stage: "split",
    projectKey: "work-automation",
    issue: {
      id: "issue-1172",
      parent: { id: "issue-1170" },
    },
  })
  const schema = buildAgentResultOutputSchema(context)

  assert.deepEqual(
    context.allowedOperations,
    AGENT_RESULT_ALLOWED_OPERATIONS_BY_STAGE.split,
  )
  assert.equal(context.parentIssueId, "issue-1170")
  assert.equal(context.target.platform, "primary-issues")
  assert.deepEqual(schema.properties.run.properties.stage.enum, ["split"])
  assert.deepEqual(
    schema.properties.run.properties.allowedOperations.items.enum,
    context.allowedOperations,
  )
  assert.deepEqual(schema.properties.target.properties.issueId.enum, ["issue-1172"])
  assert.equal(schema.properties.operations.items.anyOf.length, 3)
  assertStructuredOutputObjectFieldsAreRequired(schema)
  assert.equal(JSON.stringify(schema).includes('"const"'), false)
  assert.equal(JSON.stringify(schema).includes('"oneOf"'), false)
})

function assertStructuredOutputObjectFieldsAreRequired(schema) {
  if (!schema || typeof schema !== "object") return
  if (schema.type === "object") {
    assert.deepEqual(
      [...(schema.required || [])].sort(),
      Object.keys(schema.properties || {}).sort(),
    )
    assert.equal(schema.additionalProperties, false)
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) assertStructuredOutputObjectFieldsAreRequired(item)
    } else {
      assertStructuredOutputObjectFieldsAreRequired(value)
    }
  }
}

test("runtime failure patch keeps stable diagnostics without persisting invalid output", () => {
  const context = createAgentResultContext({
    stage: "part2",
    projectKey: "work-automation",
    issue: { id: "issue-1172" },
  })
  const evaluation = evaluateAgentResult(
    JSON.stringify({
      schemaVersion: "999",
      run: {
        stage: context.stage,
        projectKey: context.projectKey,
        parentIssueId: context.parentIssueId,
        allowedOperations: context.allowedOperations,
      },
      target: context.target,
      operations: [],
      extensions: { secret: "RESULT_SENTINEL" },
    }),
    context,
  )
  const patch = agentResultRunPatch(evaluation)

  assert.equal(patch.status, "failed")
  assert.equal(patch.agentResult, undefined)
  assert.equal(patch.agentResultValidation.error.code, "UNKNOWN_VERSION")
  assert.match(patch.error, /UNKNOWN_VERSION/u)
  assert.doesNotMatch(JSON.stringify(patch), /999|RESULT_SENTINEL/u)
})
