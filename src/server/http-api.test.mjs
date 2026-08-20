import test from "node:test"
import assert from "node:assert/strict"

import { createHttpApi } from "./http-api.mjs"

async function withServer(options, run) {
  const server = createHttpApi({
    configPath: "/tmp/work-automation-http-api-test/config.json",
    scheduler: {
      start() {},
      stop() {},
      async status() {
        return { enabled: false, running: false, nextRunAt: null, activeRuns: [] }
      },
    },
    store: {},
    ...options,
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("setup API returns status and clears Linear health after configuration", async () => {
  const setupStatus = {
    ready: false,
    needsSetup: true,
    linear: { apiKeySet: false },
    codex: { found: true },
  }
  let configuredInput = null
  let cacheCleared = false
  let schedulerStarted = false

  await withServer(
    {
      setupManager: {
        async status() {
          return setupStatus
        },
        async configure(input) {
          configuredInput = input
          return { ...setupStatus, ready: true, needsSetup: false }
        },
      },
      linearStatusHealthChecker: {
        clear() {
          cacheCleared = true
        },
      },
      scheduler: {
        start() {
          schedulerStarted = true
        },
      },
    },
    async (baseUrl) => {
      const statusResponse = await fetch(`${baseUrl}/api/setup/status`)
      assert.equal(statusResponse.status, 200)
      assert.deepEqual(await statusResponse.json(), setupStatus)

      const configureResponse = await fetch(`${baseUrl}/api/setup/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linearApiKey: "private", codexBin: "/bin/codex" }),
      })
      assert.equal(configureResponse.status, 200)
    },
  )

  assert.deepEqual(configuredInput, {
    linearApiKey: "private",
    codexBin: "/bin/codex",
  })
  assert.equal(cacheCleared, true)
  assert.equal(schedulerStarted, true)
})

test("daemon start is blocked until first-run setup is ready", async () => {
  let schedulerStarted = false
  await withServer(
    {
      setupManager: {
        async status() {
          return { ready: false, needsSetup: true }
        },
      },
      scheduler: {
        start() {
          schedulerStarted = true
        },
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/daemon/start`, { method: "POST" })
      assert.equal(response.status, 409)
      assert.match((await response.json()).error, /首次配置/)
    },
  )
  assert.equal(schedulerStarted, false)
})
