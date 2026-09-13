import assert from "node:assert/strict"
import test from "node:test"
import { buildAgentResultOutputSchema, createAgentResultContext, evaluateAgentResult } from "./agent-result-runtime.mjs"

function result(stage, schemaVersion = "2", payload = { body: "检查结论", images: [{ filePath: "review/gui/after.png", caption: "操作后" }] }) {
  const context = createAgentResultContext({ stage, projectKey: "project", issue: { id: "issue" } })
  if (schemaVersion === "1") delete context.schemaVersion
  const envelope = { schemaVersion, run: { stage, projectKey: context.projectKey, parentIssueId: null, allowedOperations: context.allowedOperations }, target: context.target, operations: [{ type: "comment.create", idempotencyKey: "result:comment", payload }] }
  return { context, envelope, evaluation: evaluateAgentResult(JSON.stringify(envelope), context) }
}

test("v2 images are part3 only; v1 text remains parseable for old runs", () => {
  assert.equal(result("part3").evaluation.ok, true)
  for (const stage of ["part1", "part2", "split"]) assert.equal(result(stage).evaluation.error.code, "OPERATION_NOT_ALLOWED")
  assert.equal(result("part3", "1").evaluation.error.code, "UNKNOWN_FIELD")
  for (const version of ["1", "2"]) assert.equal(result("part3", version, { body: "文本" }).evaluation.value.schemaVersion, version)
  for (const image of [{ filePath: "x", size: 1 }, { filePath: "x", sha256: "abc" }, { filePath: "x", contentType: "image/png" }, { filePath: "x", caption: "a\nb" }, null]) {
    assert.equal(result("part3", "2", { body: "文字", images: [image] }).evaluation.ok, false)
  }
})

test("runtime schemas advertise ordered image declarations only in part3 and never grant attachment upload", () => {
  for (const stage of ["part1", "part2", "part3", "split"]) {
    const { context } = result(stage)
    const schema = buildAgentResultOutputSchema(context)
    assert.deepEqual(schema.properties.schemaVersion.enum, ["2"])
    assert.equal(context.allowedOperations.includes("attachment.upload"), false)
    const comment = schema.properties.operations.items.anyOf.find(x => x.properties.type.enum[0] === "comment.create")
    assert.equal(Boolean(comment.properties.payload.properties.images), stage === "part3")
  }
})


test("new runs reject a v1 downgrade while persisted legacy bindings still parse v1 text", () => {
  const { context, envelope } = result("part3", "2", { body: "metadata: 保持普通文字" })
  envelope.schemaVersion = "1"
  assert.equal(evaluateAgentResult(JSON.stringify(envelope), context).error.code, "UNKNOWN_VERSION")
  delete context.schemaVersion
  assert.equal(evaluateAgentResult(JSON.stringify(envelope), context).ok, true)
  for (const body of ["![绕过](https://example.com/image)", "<img src='https://example.com/image'>", "data:image/png;base64,YQ=="]) {
    assert.equal(result("part3", "2", { body }).evaluation.ok, false)
  }
})
