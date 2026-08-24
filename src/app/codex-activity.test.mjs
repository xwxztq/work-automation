import test from "node:test"
import assert from "node:assert/strict"

import {
  createCodexActivityLoader,
  getCodexActivityScope,
} from "./codex-activity.ts"

const emptyPayload = () => ({ generatedAt: "fallback", agents: [] })

test("selects only the activity scope required by the current view", () => {
  assert.deepEqual(getCodexActivityScope("project", "alpha"), {
    kind: "project",
    projectKey: "alpha",
  })
  assert.deepEqual(getCodexActivityScope("activity", "alpha"), { kind: "global" })
  assert.equal(getCodexActivityScope("project", ""), null)
  assert.equal(getCodexActivityScope("logs", "alpha"), null)
  assert.equal(getCodexActivityScope("settings", "alpha"), null)
})

test("reuses an in-flight activity request for the same scope", async () => {
  let requestCount = 0
  const resolvers = []
  const load = createCodexActivityLoader(
    (projectKey) => {
      requestCount += 1
      if (requestCount > 2) {
        return Promise.resolve({ generatedAt: String(requestCount), agents: [{ projectKey }] })
      }
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ generatedAt: String(requestCount), agents: [{ projectKey }] }))
      })
    },
    emptyPayload,
  )

  const first = load("alpha")
  const duplicate = load("alpha")
  const global = load()

  assert.equal(first, duplicate)
  assert.notEqual(first, global)
  assert.equal(requestCount, 0)
  await Promise.resolve()
  assert.equal(requestCount, 2)

  for (const resolve of resolvers) {
    resolve()
  }
  await Promise.all([first, duplicate, global])
  await load("alpha")
  assert.equal(requestCount, 3)
})

test("returns an empty payload when the activity request fails", async () => {
  const load = createCodexActivityLoader(
    async () => {
      throw new Error("offline")
    },
    emptyPayload,
  )

  assert.deepEqual(await load("alpha"), emptyPayload())
})
