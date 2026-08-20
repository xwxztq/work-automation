import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  renderLaunchAgentPlist,
  resolveNativeServicePaths,
  writeLaunchAgentPlist,
} from "./native-service.mjs"

test("native service paths keep app versions separate from user data", () => {
  const paths = resolveNativeServicePaths({
    bundleRootDir: "/Downloads/Work Automation",
    releaseId: "0.1.0 arm64",
    homeDir: "/Users/example",
  })

  assert.equal(
    paths.appInstallDir,
    "/Users/example/Library/Application Support/WorkAutomation/app/0.1.0-arm64",
  )
  assert.equal(
    paths.runtimeRootDir,
    "/Users/example/Library/Application Support/WorkAutomation/data",
  )
  assert.equal(
    paths.plistPath,
    "/Users/example/Library/LaunchAgents/com.workautomation.agent.plist",
  )
})

test("LaunchAgent uses the bundled Node runtime and private user data directory", () => {
  const plist = renderLaunchAgentPlist({
    bundleRootDir: "/Users/example/Library/Application Support/WorkAutomation/app/release&1",
    runtimeRootDir: "/Users/example/Library/Application Support/WorkAutomation/data",
    homeDir: "/Users/example",
  })

  assert.match(plist, /runtime\/bin\/node/)
  assert.match(plist, /src\/server\/index\.mjs/)
  assert.match(plist, /WORK_AUTOMATION_HOME/)
  assert.match(plist, /\/Users\/example\/\.bun\/bin/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(plist, /release&amp;1/)
  assert.doesNotMatch(plist, /pnpm|npm|npx/)
})

test("LaunchAgent can use the Node executable that installed the npm package", () => {
  const plist = renderLaunchAgentPlist({
    bundleRootDir: "/Users/example/.nvm/versions/node/v22/lib/node_modules/@xwxztq/work-automation",
    nodePath: "/Users/example/.nvm/versions/node/v22/bin/node",
    serverEntryPath:
      "/Users/example/.nvm/versions/node/v22/lib/node_modules/@xwxztq/work-automation/src/server/index.mjs",
    runtimeRootDir: "/Users/example/Library/Application Support/WorkAutomation/data",
    homeDir: "/Users/example",
  })

  assert.match(plist, /\.nvm\/versions\/node\/v22\/bin\/node/)
  assert.match(plist, /@xwxztq\/work-automation\/src\/server\/index\.mjs/)
  assert.doesNotMatch(plist, /runtime\/bin\/node/)
})

test("LaunchAgent plist is written with user-only permissions", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-plist-"))
  const plistPath = path.join(rootDir, "Library", "LaunchAgents", "agent.plist")
  await writeLaunchAgentPlist(plistPath, "<plist/>\n")

  assert.equal(await fs.readFile(plistPath, "utf8"), "<plist/>\n")
  assert.equal((await fs.stat(plistPath)).mode & 0o777, 0o600)

  await fs.rm(rootDir, { recursive: true, force: true })
})
