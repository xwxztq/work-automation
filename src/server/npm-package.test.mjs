import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const packageMetadata = JSON.parse(
  await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
)

test("npm manifest publishes only the prebuilt runtime", () => {
  assert.equal(packageMetadata.name, "@xwxztq/work-automation")
  assert.equal(packageMetadata.private, false)
  assert.equal(packageMetadata.bin.wauto, "src/server/native-service-cli.mjs")
  assert.equal(packageMetadata.bin["work-automation"], undefined)
  assert.match(packageMetadata.engines.node, /^>=22/)
  assert.deepEqual(Object.keys(packageMetadata.dependencies), ["https-proxy-agent"])
  assert.ok(packageMetadata.files.includes("dist"))
  assert.ok(packageMetadata.files.includes("src/server/*.mjs"))
  assert.ok(packageMetadata.files.includes("!src/server/*.test.mjs"))

  for (const buildDependency of ["react", "react-dom", "lucide-react", "vite", "typescript"]) {
    assert.ok(packageMetadata.devDependencies[buildDependency], `${buildDependency} 应为开发依赖`)
  }
})

test("npm command exposes help and package version without starting the service", () => {
  const cliPath = path.join(projectRoot, "src", "server", "native-service-cli.mjs")
  const help = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" })
  const version = spawnSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" })

  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /wauto setup/)
  assert.match(help.stdout, /wauto serve/)
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), `${packageMetadata.name} ${packageMetadata.version}`)
})
