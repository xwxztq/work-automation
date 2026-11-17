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

test("all-projects fallback covers unassigned and unmapped issues without taking specific routes", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-migration-fallback-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const since = "2026-01-02T00:00:00.000Z"
  const source = { id: "source", name: "Source", mode: "migrated", inactiveSince: since }
  const route = (sourceProjectId, targetProjectKey, targetWorkspaceId = "default") => ({
    id: `mapping-${targetProjectKey}`, since, sourceWorkspaceId: source.id, sourceProjectId,
    targetProjectKey, targetWorkspaceId, targetTeamId: "team",
  })
  const fallback = route(null, "fallback")
  const specific = route("mapped", "specific")
  const disabled = route("mapped-to-disabled", "disabled")
  const inactive = route("mapped-elsewhere", "inactive", "another-workspace")
  const config = { statuses: { todo: "Todo" }, linear: { workspaces: [source], mappings: [fallback, specific, disabled, inactive] } }
  const projects = ["fallback", "specific"].map((key) => ({ key, linearProjectId: key }))
  const issue = (id, projectId, createdAt = "2026-01-03T00:00:00.000Z") => ({
    id, title: id, identifier: id, createdAt, project: projectId ? { id: projectId } : null,
  })
  const alreadyMapped = issue("explicit", "mapped")
  const unassigned = issue("unassigned", null)
  const remoteIssues = new Map()
  const destinationByTitle = new Map()
  const emptyPage = { hasNextPage: false, endCursor: null }
  let interruptReadback = true
  let sourceListsEmpty = false
  const sourceReader = createLinearReadAdapter({ async graphql(query, { projectId, after }) {
    if (projectId) {
      assert.equal(projectId, "mapped")
      return { project: { id: projectId, issues: { nodes: sourceListsEmpty ? [] : [alreadyMapped], pageInfo: emptyPage } } }
    }
    assert.match(query, /nodes \{[^}]*project \{ id \}/u)
    if (sourceListsEmpty) return { issues: { nodes: [], pageInfo: emptyPage } }
    return after
      ? { issues: { nodes: [issue("elsewhere", "mapped-elsewhere"), issue("old", null, "2026-01-01T00:00:00.000Z")], pageInfo: emptyPage } }
      : { issues: { nodes: [unassigned, issue("unmapped", "unlisted"), alreadyMapped, issue("disabled", "mapped-to-disabled")],
        pageInfo: { hasNextPage: true, endCursor: "second" } } }
  } })
  const linear = {
    async listTeamWorkflowStates() { return [{ id: "todo", name: "Todo", type: "unstarted" }] },
    async readIssue(id) {
      const value = remoteIssues.get(id)
      if (interruptReadback && value?.title === unassigned.title) throw new Error("connection lost")
      if (!value) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" })
      return value
    },
    operationWriter: { async createMigratedIssue(input) {
      assert.ok(!destinationByTitle.has(input.title))
      destinationByTitle.set(input.title, input.projectId)
      remoteIssues.set(input.id, { ...input, identifier: "DEST", project: { id: input.projectId }, team: { id: input.teamId } })
    } },
  }
  const run = () => migrateLinearIssues({ rootDir, config, projects, linear, sourceClient: () => sourceReader,
    isCurrent: async () => true, store: { async appendEvent() {} } })
  await run()
  assert.deepEqual(Object.fromEntries(destinationByTitle), {
    unassigned: "fallback", unmapped: "fallback", elsewhere: "fallback", explicit: "specific",
  })
  assert.equal((await readIssueMigration(rootDir, source, unassigned.id)).identifier, undefined)
  interruptReadback = false
  sourceListsEmpty = true
  await run()
  assert.equal((await readIssueMigration(rootDir, source, unassigned.id)).identifier, "DEST")
  assert.equal(destinationByTitle.size, 4)
})
