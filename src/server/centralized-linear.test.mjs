import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { PNG } from "pngjs"
import { createRunStore } from "./run-store.mjs"
import { createLinearReadAdapter } from "./linear-read-adapter.mjs"
import { createLinearWriteAdapter } from "./linear-write-adapter.mjs"
import { createIssueOperationExecutor } from "./issue-operation-executor.mjs"
import { createAgentResultContext, evaluateAgentResult } from "./agent-result-runtime.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"
import { auditIssueAdapter, withIssueAuditContext } from "./issue-audit.mjs"
import { redactDiagnostic } from "./diagnostic-redaction.mjs"

const statuses = { todo: "Todo", needsClarification: "Needs Clarification", tooLarge: "Too Large", needsSplitting: "Needs Splitting", blocked: "Blocked", ready: "Ready for Codex", schedule: "On Schedule", inProgress: "In Progress", testing: "Testing", readyForReview: "Ready for Review" }
const states = Object.values(statuses).map((name, index) => ({ id: `state-${index}`, name, type: "unstarted", archivedAt: null }))
const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
const project = { key: "example", linearProjectId: "project" }

async function fixture(t, stage, inputState) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "centralized-linear-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = createRunStore(root)
  const remote = new Map()
  const issue = { id: "issue", identifier: "TEST-1", title: "Synthetic issue", description: "Scope", priority: 2, state: states.find(x => x.name === inputState), project: { id: "project" }, team: { id: "team" }, parent: null, comments: connection([]), labels: connection([]), relations: connection([]), inverseRelations: connection([]), attachments: connection([]) }
  remote.set(issue.id, issue)
  const mutations = []
  let stateFailure = false
  const client = { async graphql(query, variables) {
    if (query.includes("LinearReadIssue(")) return { issue: structuredClone(remote.get(variables.issueId) || null) }
    if (query.includes("LinearReadProjectTeams")) return { project: { id: "project", teams: connection([{ id: "team" }]) } }
    if (query.includes("LinearReadTeamWorkflowStates")) return { workflowStates: connection(states) }
    const input = variables.input
    if (query.includes("LinearWriteCommentCreate")) {
      mutations.push("comment")
      const comment = { id: input.id, body: input.body }
      issue.comments.nodes.push(comment)
      return { commentCreate: { success: true, comment } }
    }
    if (query.includes("LinearWriteIssueStateUpdate")) {
      if (stateFailure) { stateFailure = false; throw Object.assign(new Error("rate limit PROVIDER_SECRET_123"), { status: 429 }) }
      mutations.push("state")
      issue.state = states.find(x => x.id === input.stateId)
      return { issueUpdate: { success: true, issue } }
    }
    if (query.includes("LinearWriteChildIssueCreate")) {
      mutations.push("child")
      const child = { ...structuredClone(issue), ...input, identifier: "TEST-2", parent: { id: input.parentId }, comments: connection([]) }
      remote.set(child.id, child)
      return { issueCreate: { success: true, issue: child } }
    }
    throw new Error("Unexpected test query")
  } }
  const reader = createLinearReadAdapter(client)
  const snapshot = await withIssueAuditContext({ stage, projectKey: project.key }, () => auditIssueAdapter(reader, store).readIssue(issue.id))
  let run = await store.createRun({ projectKey: project.key, stage, issue: snapshot })
  run = await store.updateRun(run, { agentResultContext: createAgentResultContext({ stage, projectKey: project.key, issue: snapshot }) })
  await fs.writeFile(path.join(run.dir, "image.png"), PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) }))
  const platforms = { "primary-issues": { reader, writer: createLinearWriteAdapter(client) } }
  const executor = (nextStore = store) => createIssueOperationExecutor({ store: nextStore, platforms })
  return { root, store, run, issue, remote, mutations, executor, failState: () => { stateFailure = true } }
}

function childResult(run, targetState) {
  const c = run.agentResultContext
  // An actual child process receives the public envelope with a filtered environment.
  const script = `let s=''; for await (const c of process.stdin) s+=c; const x=JSON.parse(s); if(Object.keys(process.env).some(k=>/LINEAR|MCP|WORK_ISSUE_TOKEN/.test(k))) process.exit(31); const childKey='test:split:child'; const operations=[]; if(x.stage==='split') operations.push({type:'issue.child.create',idempotencyKey:childKey,payload:{title:'Child',description:'Child scope'}}); operations.push({type:'comment.create',idempotencyKey:'test:'+x.stage+':comment',payload:{body:x.stage==='split'?'Codex Split Complete '+childKey:'Stage complete',...(x.stage==='part3'?{images:[{filePath:'image.png',caption:'Evidence'}]}:{})}}); operations.push({type:'issue.state.update',idempotencyKey:'test:'+x.stage+':state',payload:{state:x.targetState}}); console.log(JSON.stringify({schemaVersion:x.schemaVersion,run:{stage:x.stage,projectKey:x.projectKey,parentIssueId:x.parentIssueId,allowedOperations:x.allowedOperations},target:x.target,operations}));`
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify({ ...c, targetState }), encoding: "utf8", env: buildCodexProcessEnv({ ...process.env, LINEAR_API_KEY: "LINEAR_SENTINEL", MCP_LINEAR_TOKEN: "MCP_SENTINEL", WORK_ISSUE_TOKEN: "CUSTOM_SENTINEL" }, { blockedNames: ["WORK_ISSUE_TOKEN"] }) })
  assert.equal(result.status, 0, result.stderr)
  const evaluation = evaluateAgentResult(result.stdout, c)
  assert.equal(evaluation.ok, true)
  return evaluation.value
}

for (const [stage, input, output] of [["part1", "Todo", "Ready for Codex"], ["split", "Needs Splitting", "In Progress"], ["part2", "On Schedule", "Testing"], ["part3", "Testing", "Ready for Review"]]) {
  test(`${stage}: snapshot, credential-free child, adapters, verification, restart and audit`, async (t) => {
    const f = await fixture(t, stage, input)
    const result = childResult(f.run, output)
    if (stage === "part3") f.failState()
    const execute = (executor) => executor.execute({ run: f.run, project, config: { statuses }, agentResult: result })
    const first = await execute(f.executor())
    assert.equal(first.status, stage === "part3" ? "retryable" : "completed", JSON.stringify(first))
    const restarted = createRunStore(f.root)
    assert.equal((await execute(f.executor(restarted))).status, "completed")
    assert.equal(f.issue.comments.nodes.length, 1)
    assert.equal(f.issue.state.name, output)
    assert.equal(f.mutations.filter(x => x === "comment").length, 1)
    if (stage === "split") { assert.equal(f.remote.size, 2); assert.equal([...f.remote.values()][1].parent.id, f.issue.id) }
    const audit = await restarted.listIssueAudit(f.run.id)
    assert.ok(audit.some(x => x.operation === "issue.read" && x.result === "succeeded"))
    assert.ok(audit.some(x => x.operation === "comment.create" && x.result === "verified" && x.idempotencyKey === `test:${stage}:comment`))
    if (stage === "part3") assert.ok(audit.some(x => x.errorCode === "RATE_LIMITED" && x.failureCategory === "provider"))
    assert.doesNotMatch(JSON.stringify(audit), /SENTINEL|PROVIDER_SECRET|Authorization|data:image/u)
    assert.ok((await restarted.getRun(f.run.id)).audit.length > 0)
  })
}

test("invalid output and unsafe image declarations fail before mutation and are audited", async (t) => {
  const f = await fixture(t, "part3", "Testing")
  const result = childResult(f.run, "Ready for Review")
  result.operations[0].payload.images[0].filePath = "../outside.png"
  const outcome = await f.executor().execute({ run: f.run, project, config: { statuses }, agentResult: result })
  assert.equal(outcome.status, "manual-required")
  assert.deepEqual(f.mutations, [])
  assert.equal((await f.store.listIssueAudit(f.run.id)).at(-1).failureCategory, "service-validation")
  result.schemaVersion = "999"
  assert.equal(evaluateAgentResult(JSON.stringify(result), f.run.agentResultContext).ok, false)
  assert.deepEqual(f.mutations, [])
})

test("diagnostics redact credentials and audit ignores provider payloads", async (t) => {
  const f = await fixture(t, "part1", "Todo")
  const value = redactDiagnostic({ authorization: "secret", message: "Authorization: Bearer opaque-secret https://user:pass@example.com/x?signature=private lin_api_123456789012345678901234", nested: ["CUSTOM_VALUE"] }, ["CUSTOM_VALUE"])
  assert.doesNotMatch(JSON.stringify(value), /opaque-secret|user:pass|signature=private|lin_api_|CUSTOM_VALUE/u)
  await f.store.appendIssueAudit({ runId: f.run.id, operation: "issue.read", result: "failed", payload: "PRIVATE_PAYLOAD", headers: { Authorization: "PRIVATE_TOKEN" } })
  assert.doesNotMatch(JSON.stringify(await f.store.listIssueAudit(f.run.id)), /PRIVATE_PAYLOAD|PRIVATE_TOKEN/u)
})

test("concurrent runs retain separate audit context and an audit failure prevents provider calls", async (t) => {
  const f = await fixture(t, "part1", "Todo")
  let providerCalls = 0
  const adapter = auditIssueAdapter({ async readIssue(id) { providerCalls++; await new Promise(resolve => setImmediate(resolve)); return { id } } }, f.store)
  await Promise.all(["run-a", "run-b"].map(runId => withIssueAuditContext({ runId, stage: "part1", projectKey: runId }, () => adapter.readIssue(runId))))
  for (const id of ["run-a", "run-b"]) {
    const records = await f.store.listIssueAudit(id)
    assert.equal(records.length, 2)
    assert.ok(records.every(record => record.runId === id && record.issueId === id && record.projectKey === id))
  }
  const blocked = auditIssueAdapter({ async createComment() { providerCalls++ } }, { async appendIssueAudit() { throw new Error("disk unavailable") } })
  await assert.rejects(blocked.createComment({ target: { issueId: "issue" }, idempotencyKey: "stable" }), /disk unavailable/u)
  assert.equal(providerCalls, 2)
})
