#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outputDir = path.join(projectRoot, "artifacts", "npm")
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"

await fs.mkdir(outputDir, { recursive: true })

const result = spawnSync(
  npmCommand,
  ["pack", "--pack-destination", outputDir, ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
