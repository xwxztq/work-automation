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

  assert.ok(candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex"))
  assert.ok(candidates.includes("/Users/example/.local/bin/codex"))
  assert.ok(candidates.includes("/Users/example/.bun/bin/codex"))
})
