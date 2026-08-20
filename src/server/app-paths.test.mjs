import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  defaultRuntimeRoot,
  ensureRuntimeLayout,
  resolveRuntimePaths,
} from "./app-paths.mjs"

test("defaultRuntimeRoot uses the platform user data directory", () => {
  assert.equal(
    defaultRuntimeRoot({ platform: "darwin", homeDir: "/Users/demo", env: {} }),
    "/Users/demo/Library/Application Support/WorkAutomation/data",
  )
  assert.equal(
    defaultRuntimeRoot({
      platform: "win32",
      homeDir: "C:\\Users\\demo",
      env: { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" },
    }),
    path.join("C:\\Users\\demo\\AppData\\Local", "WorkAutomation", "data"),
  )
  assert.equal(
    defaultRuntimeRoot({
      platform: "linux",
      homeDir: "/home/demo",
      env: { XDG_DATA_HOME: "/data/demo" },
    }),
    "/data/demo/work-automation/data",
  )
})

test("resolveRuntimePaths keeps explicit development paths relative to the launch cwd", () => {
  const paths = resolveRuntimePaths({
    appRootDir: "/repo/work-automation",
    launchCwd: "/repo/work-automation",
    runtimeRoot: ".",
    configPath: "config.local.json",
    env: {},
  })

  assert.equal(paths.runtimeRootDir, "/repo/work-automation")
  assert.equal(paths.configPath, "/repo/work-automation/config.local.json")
  assert.equal(paths.stateDir, "/repo/work-automation/.linear-automation")
})

test("ensureRuntimeLayout copies bundled prompts once and preserves user edits", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-paths-"))
  const appRootDir = path.join(rootDir, "app")
  const runtimeRootDir = path.join(rootDir, "data")
  await fs.mkdir(path.join(appRootDir, "prompts"), { recursive: true })
  await fs.writeFile(path.join(appRootDir, "prompts", "part1.global.md"), "bundled\n")

  const paths = resolveRuntimePaths({
    appRootDir,
    runtimeRoot: runtimeRootDir,
    env: {},
  })
  await ensureRuntimeLayout(paths)
  await fs.writeFile(path.join(runtimeRootDir, "prompts", "part1.global.md"), "custom\n")
  await ensureRuntimeLayout(paths)

  assert.equal(
    await fs.readFile(path.join(runtimeRootDir, "prompts", "part1.global.md"), "utf8"),
    "custom\n",
  )
  await fs.rm(rootDir, { recursive: true, force: true })
})
