import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createIssueProgressSession, initializeIssueProgress } from "./issue-progress.mjs"
import { requestIssueProgress } from "./issue-progress-client.mjs"

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-progress-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const run = { id: "run", dir, stage: "superpower", status: "running", issueBinding: { stateId: "todo", stateName: "Todo" } }
  await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(run))
  await initializeIssueProgress(run, { statuses: { inProgress: "Doing", testing: "Checking" } })
  return run
}

test("progress inbox rejects invalid states, oversized files, symlinks and hardlinks without platform writes", async (t) => {
  const run = await fixture(t)
  const requests = path.join(run.dir, "progress", "requests")
  const invalid = [JSON.stringify({ state: "Done" }), JSON.stringify({ state: "testing", issueId: "other" }), "x".repeat(2048)]
  const names = []
  for (const content of invalid) {
    const name = `${randomUUID()}.json`
    names.push(name)
    await fs.writeFile(path.join(requests, name), content)
  }
  const source = path.join(run.dir, "source.json")
  await fs.writeFile(source, JSON.stringify({ state: "testing" }))
  for (const link of [fs.symlink, fs.link]) {
    const name = `${randomUUID()}.json`
    names.push(name)
    await link(source, path.join(requests, name))
  }
  let writes = 0
  const session = createIssueProgressSession({ run,
    store: { async getRunMetadata() { return run } },
    execute: async () => { writes += 1 },
  })
  assert.equal((await session.finish()).status, "completed")
  assert.equal(writes, 0)
  for (const name of names) {
    const response = JSON.parse(await fs.readFile(path.join(run.dir, "progress", "responses", name), "utf8"))
    assert.equal(response.ok, false)
  }
  await assert.rejects(requestIssueProgress(run.dir, "testing"), /停止接收/)
})

test("canceled runs cannot apply queued progress requests", async (t) => {
  const run = await fixture(t)
  await fs.writeFile(path.join(run.dir, "progress", "requests", `${randomUUID()}.json`), JSON.stringify({ state: "testing" }))
  let writes = 0
  const session = createIssueProgressSession({ run,
    store: { async getRunMetadata() { return { ...run, status: "canceled" } } },
    execute: async () => { writes += 1 },
  })
  assert.equal((await session.finish()).error.code, "CANCELED")
  assert.equal(writes, 0)
})

test("progress client validates the state and reports unacknowledged requests as a timeout", async (t) => {
  const run = await fixture(t)
  await assert.rejects(requestIssueProgress(run.dir, "Done"), /只支持/)
  await assert.rejects(requestIssueProgress(run.dir, "testing", { timeoutMs: 30, pollMs: 5 }), /超时/)
  assert.equal((await fs.readdir(path.join(run.dir, "progress", "requests"))).length, 1)
})
