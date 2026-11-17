import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  knownCodexExecutableCandidates,
  resolveCodexExecutable,
  resolveExecutable,
} from "./executable.mjs"

test("resolveExecutable searches the supplied PATH", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-executable-"))
  const executable = path.join(rootDir, "codex")
  await fs.writeFile(executable, "#!/bin/sh\n")
  await fs.chmod(executable, 0o755)

  assert.equal(await resolveExecutable("codex", { path: rootDir }), executable)

  await fs.rm(rootDir, { recursive: true, force: true })
})

test("resolveCodexExecutable falls back to a known absolute location", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-codex-"))
  const executable = path.join(rootDir, "codex")
  await fs.writeFile(executable, "#!/bin/sh\n")
  await fs.chmod(executable, 0o755)

  assert.equal(
    await resolveCodexExecutable("codex", {
      path: "",
      candidates: [path.join(rootDir, "missing"), executable],
    }),
    executable,
  )

  await fs.rm(rootDir, { recursive: true, force: true })
})

test("known Codex locations include the ChatGPT app and user CLI directories on macOS", () => {
  const candidates = knownCodexExecutableCandidates({
    platform: "darwin",
    homeDir: "/Users/example",
  })

  assert.ok(candidates.includes(path.normalize("/Applications/ChatGPT.app/Contents/Resources/codex")))
  assert.ok(candidates.includes(path.normalize("/Users/example/.local/bin/codex")))
  assert.ok(candidates.includes(path.normalize("/Users/example/.bun/bin/codex")))
})

test("a running service rediscovers desktop Codex after its pinned version is removed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-codex-upgrade-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bin = path.join(root, "OpenAI", "Codex", "bin")
  const old = path.join(bin, "aaa111", "codex.exe")
  const next = path.join(bin, "bbb222", "codex.exe")
  const options = { platform: "win32", env: { LOCALAPPDATA: root }, path: "", candidates: [] }
  for (const file of [old, next]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "fixture")
    await fs.chmod(file, 0o755)
  }
  await fs.mkdir(path.join(bin, "ccc333"))
  assert.equal(await resolveCodexExecutable(old, options), old)
  await fs.rm(old)
  assert.equal(await resolveCodexExecutable(old, options), next)
  assert.equal(await resolveCodexExecutable("codex", options), next)
  assert.equal(await resolveCodexExecutable(old, { ...options, fallbackKnownLocations: false }), null)
  await fs.rm(next)
  assert.equal(await resolveCodexExecutable(old, options), null)
})
