import assert from "node:assert/strict"
import test from "node:test"
import { autoArchiveProject } from "./issue-auto-archive.mjs"
import { createLinearReadAdapter } from "./linear-read-adapter.mjs"
import { createLinearWriteAdapter } from "./linear-write-adapter.mjs"

const ago = (day) => `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`

test("archives only continuously terminal leaves whose status is still current", async () => {
  const issues = new Map()
  const histories = new Map()
  const archived = []
  const pass = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
  const add = (id, patch = {}, history = []) => {
    issues.set(id, { id, identifier: id, createdAt: ago(1), updatedAt: ago(17), archivedAt: null,
      project: { id: "project" }, state: { id: "done", type: "completed" }, completedAt: ago(9), children: pass, ...patch })
    histories.set(id, history)
  }
  const transition = (day, fromStateId, toStateId) => ({ createdAt: ago(day), updatedAt: ago(day), fromStateId, toStateId })
  add("boundary", {}, [transition(10, "todo", "done")])
  add("reopened-and-closed", {}, [transition(16, "todo", "done"), transition(10, "done", "todo"), transition(9, "todo", "done")])
  add("other-done-state", {}, [transition(14, "another-done", "done")])
  add("canceled", { state: { id: "canceled", type: "canceled" }, canceledAt: ago(6) }, [transition(6, "todo", "canceled")])
  add("parent", { children: { ...pass, nodes: [{ id: "child" }] } }, [transition(9, "todo", "done")])
  add("changed-after-read", {}, [transition(9, "todo", "done")])
  add("active-run", {}, [transition(9, "todo", "done")])
  add("initial-terminal", { updatedAt: ago(7) })
  add("inconclusive", {}, [transition(9, "done", "todo")])
  const events = []
  const client = { async graphql(query, { issueId, id, before, after }) {
    if (query.includes("query LinearArchiveCandidates")) {
      assert.equal(before, ago(10))
      return { project: { id: "project", issues: { ...pass, nodes: [...issues.values()] } } }
    }
    if (query.includes("query LinearArchiveHistory")) {
      const history = histories.get(issueId)
      const hasNextPage = history.length > 1 && !after
      return { issue: { ...issues.get(issueId), history: { nodes: after ? history.slice(1) : history.slice(0, 1),
        pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null } } } }
    }
    if (query.includes("query LinearArchiveState")) {
      const issue = issues.get(issueId)
      return { issue: issueId === "changed-after-read" ? { ...issue, state: { id: "todo", type: "unstarted" } } : issue }
    }
    assert.match(query, /issueArchive\(id: \$id, trash: false\)/u)
    const issue = issues.get(id)
    assert.ok(!issue.archivedAt)
    issue.archivedAt = ago(17)
    archived.push(id)
    return { issueArchive: { success: true, entity: { id, archivedAt: issue.archivedAt } } }
  } }
  const linear = { ...createLinearReadAdapter(client), operationWriter: createLinearWriteAdapter(client) }
  const run = () => autoArchiveProject({ project: { key: "project", linearProjectId: "project", autoArchive: { enabled: true, days: 7 } },
    linear, logEvent: async (event) => events.push(event), archiving: new Set(),
    isCurrent: async () => true, isBusy: async (id) => id === "active-run", now: Date.parse(ago(17)) })
  await run()
  await run()
  assert.deepEqual(archived, ["boundary", "canceled", "initial-terminal"])
  assert.deepEqual(events.map((event) => event.type), Array(3).fill("issue-auto-archived"))
})
