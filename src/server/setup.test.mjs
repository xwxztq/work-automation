import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { loadConfig } from "./config.mjs"
import { parseEnvContent } from "./env.mjs"
import { resolveCodexExecutable } from "./executable.mjs"
import { createSetupManager } from "./setup.mjs"

async function fixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-setup-"))
  const codexBin = path.join(rootDir, "bin", "codex")
  await fs.mkdir(path.dirname(codexBin), { recursive: true })
  await fs.writeFile(codexBin, "#!/bin/sh\n")
  await fs.chmod(codexBin, 0o755)
  return {
    rootDir,
    codexBin,
    configPath: path.join(rootDir, "config.json"),
  }
}

test("setup status reports missing requirements without exposing a secret", async () => {
  const input = await fixture()
  const manager = createSetupManager({
    ...input,
    env: { PATH: "" },
    resolveCodex: (command, options) =>
      resolveCodexExecutable(command, { ...options, candidates: [] }),
  })

  const status = await manager.status()
  assert.equal(status.ready, false)
  assert.equal(status.linear.apiKeySet, false)
  assert.equal(status.codex.found, false)
  assert.equal(JSON.stringify(status).includes("secret"), false)

  await fs.rm(input.rootDir, { recursive: true, force: true })
})

test("a detected Codex command still requires saving its absolute path", async () => {
  const input = await fixture()
  const manager = createSetupManager({
    ...input,
    env: { PATH: "", LINEAR_API_KEY: "already-set" },
    resolveCodex: async () => input.codexBin,
  })

  const status = await manager.status()
  assert.equal(status.codex.found, true)
  assert.equal(status.codex.absolutePathSaved, false)
  assert.equal(status.ready, false)

  await fs.rm(input.rootDir, { recursive: true, force: true })
})

test("setup validates Linear, stores the key privately, and persists an absolute Codex path", async () => {
  const input = await fixture()
  const env = { PATH: "" }
  let validatedKey = ""
  const manager = createSetupManager({
    ...input,
    env,
    createLinear: (apiKey) => ({
      async listProjects() {
        validatedKey = apiKey
        return []
      },
    }),
  })

  const status = await manager.configure({
    linearApiKey: "lin_api_private",
    codexBin: input.codexBin,
  })

  assert.equal(validatedKey, "lin_api_private")
  assert.equal(status.ready, true)
  assert.equal(status.linear.apiKeySet, true)
  assert.equal(status.codex.resolvedBin, input.codexBin)

  const savedConfig = await loadConfig(input.configPath, input.rootDir)
  assert.equal(savedConfig.codex.bin, input.codexBin)
  const envPath = path.join(input.rootDir, ".env.local")
  const envContent = await fs.readFile(envPath, "utf8")
  assert.equal(parseEnvContent(envContent).LINEAR_API_KEY, "lin_api_private")
  assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600)

  await fs.rm(input.rootDir, { recursive: true, force: true })
})

test("setup does not persist a rejected Linear API key", async () => {
  const input = await fixture()
  const manager = createSetupManager({
    ...input,
    env: { PATH: "" },
    createLinear: () => ({
      async listProjects() {
        throw new Error("Unauthorized")
      },
    }),
  })

  await assert.rejects(
    manager.configure({ linearApiKey: "rejected", codexBin: input.codexBin }),
    /Linear API key 校验失败/,
  )
  await assert.rejects(fs.access(path.join(input.rootDir, ".env.local")))

  await fs.rm(input.rootDir, { recursive: true, force: true })
})
