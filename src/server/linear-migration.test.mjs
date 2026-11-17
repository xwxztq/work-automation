import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createLinearReadAdapter } from "./linear-read-adapter.mjs"
import { migrateLinearIssues, readIssueMigration } from "./linear-migration.mjs"

test("migration recovers an uncertain write and routes multiple source projects to one target", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-migration-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const source = { id: "source", name: "Source", mode: "migrated", inactiveSince: "2026-01-02T00:00:00.000Z" }
  const old = { id: "old", createdAt: "2026-01-01T00:00:00.000Z" }
  const issues = ["one", "two"].map((id) => ({ id, identifier: id.toUpperCase(), title: id,
    priority: 2, description: `Description of ${id}`, url: `https://linear.app/source/issue/${id}`,
    createdAt: "2026-01-03T00:00:00.000Z" }))
  const projects = [{ key: "target", linearProjectId: "target-project" }]
  const config = { statuses: { todo: "Target queue" }, linear: {
    workspaces: [source], mappings: issues.map(({ id }) => ({ id, sourceWorkspaceId: "source", sourceProjectId: id,
      targetProjectKey: "target", targetTeamId: "target-team", since: "2026-01-02T00:00:00.000Z" })),
  } }
  let interruptReadback = true
  let clearSourceLists = false
  const targetIssues = new Map()
  const events = []
  const inputs = []
  const linear = {
    async listTeamWorkflowStates() { return [{ id: "target-todo", name: "Target queue", type: "unstarted" }] },
    async readIssue(id) {
      const issue = targetIssues.get(id)
      if (interruptReadback && issue?.title === "one") throw new Error("connection lost")
      if (!issue) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND" })
      return issue
    },
    operationWriter: { async createMigratedIssue(input) {
      assert.equal(input.stateId, "target-todo")
      assert.equal(input.priority, 2)
      assert.equal(input.projectId, "target-project")
      assert.equal(input.teamId, "target-team")
      inputs.push(input)
      const issue = { ...input, identifier: `TARGET-${inputs.length}`,
        project: { id: input.projectId }, team: { id: input.teamId } }
      targetIssues.set(input.id, issue)
      if (interruptReadback && input.title === "one") throw new Error("response lost")
      return issue
    } },
  }
  const sourceReader = createLinearReadAdapter({ async graphql(query, { projectId, since, after }) {
    assert.match(query, /createdAt: \{ gte: \$since \}/u)
    assert.ok(since >= "2026-01-02T00:00:00.000Z")
    const nodes = clearSourceLists ? [] : after ? issues.filter((issue) => issue.id === projectId) : [old]
    return { project: { id: projectId, issues: { nodes, pageInfo: { hasNextPage: !after, endCursor: after ? null : "next" } } } }
  } })
  const run = () => migrateLinearIssues({ rootDir, config, projects, linear, sourceClient: () => sourceReader,
    isCurrent: async () => true, store: { async appendEvent(event) { events.push(event) } } })
  await run()
  assert.equal(events.filter((item) => item.type === "issue-migration-error").length, 1)
  assert.equal((await readIssueMigration(rootDir, source, "one")).identifier, undefined)
  assert.equal((await readIssueMigration(rootDir, source, "two")).identifier, "TARGET-2")
  interruptReadback = false
  clearSourceLists = true
  source.inactiveSince = "2026-01-05T00:00:00.000Z"
  await run()
  await run()
  assert.equal(inputs.length, 2)
  assert.equal((await readIssueMigration(rootDir, source, "one")).identifier, "TARGET-1")
  assert.equal(await readIssueMigration(rootDir, source, "old"), null)
  assert.equal(events.filter((item) => item.type === "issue-migrated").length, 2)
})
