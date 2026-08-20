import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createRunStore } from "./run-store.mjs"

test("reads recent events from the end without breaking multibyte JSON lines", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-events-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  const store = createRunStore(rootDir)
  await fs.mkdir(path.dirname(store.eventsPath), { recursive: true })
  const entries = [
    { timestamp: "2026-01-01T00:00:00.000Z", projectKey: "alpha", type: "old", message: "测".repeat(30_000) },
    { timestamp: "2026-01-01T00:00:01.000Z", projectKey: "beta", type: "one", message: "一" },
    { timestamp: "2026-01-01T00:00:02.000Z", projectKey: "alpha", type: "two", message: "二" },
    { timestamp: "2026-01-01T00:00:03.000Z", projectKey: "beta", type: "three", message: "三" },
    { timestamp: "2026-01-01T00:00:04.000Z", projectKey: "alpha", type: "four", message: "四" },
  ]
  await fs.writeFile(store.eventsPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)

  const recent = await store.listEvents({ limit: 3 })
  const recentAlpha = await store.listEvents({ limit: 3, projectKey: "alpha" })

  assert.deepEqual(recent.map((entry) => entry.type), ["four", "three", "two"])
  assert.deepEqual(recentAlpha.map((entry) => entry.type), ["four", "two", "old"])
  assert.equal(recentAlpha.at(-1).message, "测".repeat(30_000))
})

test("marks new runs for review cleanup on completion", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-run-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  const store = createRunStore(rootDir)
  const run = await store.createRun({
    projectKey: "project",
    stage: "part3",
    issue: { id: "issue-1", identifier: "LIV-1", title: "Review" },
  })

  assert.equal(run.cleanupReviewTempOnCompletion, true)
})

test("preserves supervisor metadata when the scheduler updates a stale run object", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-run-merge-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  const store = createRunStore(rootDir)
  const run = await store.createRun({
    projectKey: "project",
    stage: "part3",
    issue: { id: "issue-2", identifier: "LIV-2", title: "Merge" },
  })
  const persisted = JSON.parse(await fs.readFile(run.metadataPath, "utf8"))
  await fs.writeFile(run.metadataPath, `${JSON.stringify({
    ...persisted,
    supervisorPid: 1234,
    reviewCleanup: { completedAt: "2026-01-01T00:00:00.000Z", removedEntries: ["_work"] },
  }, null, 2)}\n`)

  const updated = await store.updateRun(run, { status: "succeeded" })

  assert.equal(updated.status, "succeeded")
  assert.equal(updated.supervisorPid, 1234)
  assert.deepEqual(updated.reviewCleanup.removedEntries, ["_work"])
})
