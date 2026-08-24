import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { DirectoryPickerUnavailableError } from "./directory-picker.mjs"
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

test("activity API reads only metadata for runs in the requested project", async () => {
  const metadataReads = []
  const summarizedRuns = []
  const retainedRuns = []

  await withServer(
    {
      scheduler: {
        async status() {
          return {
            activeRuns: [
              { runId: "run-alpha", projectKey: "alpha", stage: "part2", startedAt: "2026-01-01T00:00:00.000Z" },
              { runId: "run-beta", projectKey: "beta", stage: "part2", startedAt: "2026-01-01T00:00:01.000Z" },
            ],
          }
        },
      },
      store: {
        async getRunMetadata(runId) {
          metadataReads.push(runId)
          return {
            id: runId,
            projectKey: runId === "run-alpha" ? "alpha" : "beta",
            stage: "part2",
            status: "running",
            createdAt: "2026-01-01T00:00:00.000Z",
          }
        },
        async getRun() {
          throw new Error("activity endpoint must not hydrate full run artifacts")
        },
      },
      codexActivityReader: {
        async summarize(run) {
          summarizedRuns.push(run.id)
          return {
            runId: run.id,
            projectKey: run.projectKey,
            stage: run.stage,
            startedAt: run.createdAt,
            status: run.status,
            updatedAt: run.createdAt,
            activityKind: "waiting",
            activityMotion: "waiting",
            activityTool: "other",
            activityLabel: "等待输出",
            detail: "",
          }
        },
        retain(runIds) {
          retainedRuns.push([...runIds])
        },
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/codex/activity?projectKey=alpha`)
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.deepEqual(payload.agents.map((agent) => agent.runId), ["run-alpha"])
    },
  )

  assert.deepEqual(metadataReads, ["run-alpha"])
  assert.deepEqual(summarizedRuns, ["run-alpha"])
  assert.deepEqual(retainedRuns, [["run-alpha", "run-beta"]])
})

test("directory picker API exposes capability and successful selection", async () => {
  let pickCalls = 0
  await withServer(
    {
      directoryPicker: {
        async getCapability() {
          return { available: true }
        },
        async pickDirectory() {
          pickCalls += 1
          return { status: "selected", path: "/Users/example/Projects/demo" }
        },
      },
    },
    async (baseUrl) => {
      const capability = await fetch(`${baseUrl}/api/directory-picker`)
      assert.equal(capability.status, 200)
      assert.deepEqual(await capability.json(), { available: true })

      const selection = await fetch(`${baseUrl}/api/directory-picker`, { method: "POST" })
      assert.equal(selection.status, 200)
      assert.deepEqual(await selection.json(), {
        status: "selected",
        path: "/Users/example/Projects/demo",
      })
    },
  )
  assert.equal(pickCalls, 1)
})

test("directory picker API preserves cancellation and distinguishes unavailable from failure", async () => {
  for (const scenario of [
    {
      expectedStatus: 200,
      pickDirectory: async () => ({ status: "canceled" }),
      expectedBody: { status: "canceled" },
    },
    {
      expectedStatus: 409,
      pickDirectory: async () => {
        throw new DirectoryPickerUnavailableError()
      },
      expectedError: /不支持交互式目录选择/,
    },
    {
      expectedStatus: 500,
      pickDirectory: async () => {
        throw new Error("selector failed")
      },
      expectedError: /selector failed/,
    },
  ]) {
    await withServer(
      {
        directoryPicker: {
          async getCapability() {
            return { available: true }
          },
          pickDirectory: scenario.pickDirectory,
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/directory-picker`, { method: "POST" })
        assert.equal(response.status, scenario.expectedStatus)
        const body = await response.json()
        if (scenario.expectedBody) {
          assert.deepEqual(body, scenario.expectedBody)
        } else {
          assert.match(body.error, scenario.expectedError)
        }
      },
    )
  }
})

test("production static server decodes encoded asset paths", async (t) => {
  const staticRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-static-"))
  t.after(() => fs.rm(staticRootDir, { recursive: true, force: true }))
  const assetPath = path.join(
    staticRootDir,
    "dist/pixel-agents/assets/furniture/Modern Office 48x48.png",
  )
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await fs.mkdir(path.dirname(assetPath), { recursive: true })
  await fs.writeFile(assetPath, png)
  await fs.writeFile(path.join(staticRootDir, "dist/index.html"), "<main>SPA</main>")

  await withServer({ staticRootDir }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/pixel-agents/assets/furniture/Modern%20Office%2048x48.png`,
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "image/png")
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  })
})

test("production static server rejects unsafe encodings and preserves SPA fallback", async (t) => {
  const staticRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-static-"))
  t.after(() => fs.rm(staticRootDir, { recursive: true, force: true }))
  await fs.mkdir(path.join(staticRootDir, "dist"), { recursive: true })
  await fs.writeFile(path.join(staticRootDir, "dist/index.html"), "<main>SPA</main>")
  await fs.writeFile(path.join(staticRootDir, "outside.txt"), "private")

  await withServer({ staticRootDir }, async (baseUrl) => {
    const traversal = await fetch(`${baseUrl}/..%2Foutside.txt`)
    assert.equal(traversal.status, 403)
    assert.match((await traversal.json()).error, /无权访问/)

    const malformed = await fetch(`${baseUrl}/%E0%A4%A`)
    assert.equal(malformed.status, 400)
    assert.match((await malformed.json()).error, /编码无效/)

    const nullByte = await fetch(`${baseUrl}/asset%00.png`)
    assert.equal(nullByte.status, 400)
    assert.match((await nullByte.json()).error, /路径无效/)

    const route = await fetch(`${baseUrl}/projects/example/activity`)
    assert.equal(route.status, 200)
    assert.equal(route.headers.get("content-type"), "text/html; charset=utf-8")
    assert.equal(await route.text(), "<main>SPA</main>")
  })
})
