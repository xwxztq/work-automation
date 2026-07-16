import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { applyRuntimeConfigOverrides, normalizeConfig, saveConfig } from "./config.mjs"

test("notification defaults match the four-stage policy", () => {
  const config = normalizeConfig({})

  assert.deepEqual(config.notifications, {
    part1: { succeeded: true, failed: true },
    split: { succeeded: false, failed: true },
    part2: { succeeded: false, failed: true },
    part3: { succeeded: true, failed: true },
  })
})

test("notification normalization preserves defaults for partial config", () => {
  const config = normalizeConfig({ notifications: { part2: { succeeded: true } } })

  assert.deepEqual(config.notifications.part2, { succeeded: true, failed: true })
  assert.deepEqual(config.notifications.part1, { succeeded: true, failed: true })
})

test("webhook defaults to disabled and normalization preserves its template", () => {
  assert.deepEqual(normalizeConfig({}).webhook, { enabled: false, urlTemplate: "" })
  assert.deepEqual(
    normalizeConfig({ webhook: { enabled: true, urlTemplate: "https://example.com/{IssueID}" } }).webhook,
    { enabled: true, urlTemplate: "https://example.com/{IssueID}" },
  )
})

test("saving an enabled webhook rejects an invalid URL template", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-config-"))
  await assert.rejects(
    saveConfig("config.json", { webhook: { enabled: true, urlTemplate: "https://example.com/{unknown}" } }, rootDir),
    /未知变量/,
  )
  await fs.rm(rootDir, { recursive: true, force: true })
})

test("runtime sandbox overrides do not mutate the saved config", () => {
  const config = normalizeConfig({})
  const overridden = applyRuntimeConfigOverrides(config, {
    LINEAR_AUTOMATION_PART1_SANDBOX: "danger-full-access",
    LINEAR_AUTOMATION_SPLIT_SANDBOX: "danger-full-access",
  })

  assert.equal(config.codex.part1Sandbox, "read-only")
  assert.equal(config.codex.splitSandbox, "read-only")
  assert.equal(overridden.codex.part1Sandbox, "danger-full-access")
  assert.equal(overridden.codex.splitSandbox, "danger-full-access")
})

test("runtime sandbox overrides reject unknown modes", () => {
  const config = normalizeConfig({})
  assert.throws(
    () =>
      applyRuntimeConfigOverrides(config, {
        LINEAR_AUTOMATION_PART1_SANDBOX: "privileged",
      }),
    /LINEAR_AUTOMATION_PART1_SANDBOX/,
  )
})
