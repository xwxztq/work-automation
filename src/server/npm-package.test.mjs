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
const npmPublishWorkflow = await fs.readFile(
  path.join(projectRoot, ".github", "workflows", "publish-npm.yml"),
  "utf8",
)
const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8")

test("npm manifest publishes only the prebuilt runtime", () => {
  assert.equal(packageMetadata.name, "@xwxztq/work-automation")
  assert.equal(packageMetadata.private, false)
  assert.equal(packageMetadata.bin.wauto, "src/server/native-service-cli.mjs")
  assert.equal(packageMetadata.bin["work-automation"], undefined)
  assert.match(packageMetadata.engines.node, /^>=22/)
  assert.deepEqual(Object.keys(packageMetadata.dependencies), ["https-proxy-agent", "jpeg-js", "pngjs"])
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

test("npm publish workflow only releases new versions pushed to main", () => {
  assert.match(npmPublishWorkflow, /^on:\n  push:\n    branches:\n      - main$/m)
  assert.doesNotMatch(
    npmPublishWorkflow,
    /^\s{0,2}(pull_request|workflow_dispatch|schedule):/m,
  )
  assert.match(npmPublishWorkflow, /^permissions:\n  contents: read\n  id-token: write$/m)
  assert.match(npmPublishWorkflow, /^concurrency:\n  group: npm-publish-/m)
  assert.match(npmPublishWorkflow, /npm view "\$package_spec" version --json/)
  assert.match(npmPublishWorkflow, /::notice title=Publish skipped/)
  assert.match(npmPublishWorkflow, /steps\.registry\.outputs\.exists == 'false'/)
  assert.match(npmPublishWorkflow, /pnpm install --frozen-lockfile/)
  assert.match(npmPublishWorkflow, /run: pnpm test/)
  assert.match(npmPublishWorkflow, /run: pnpm build/)
  assert.match(npmPublishWorkflow, /run: npm publish --access public/)
})

test("npm publish workflow uses the pinned OIDC toolchain without publish secrets", () => {
  const pnpmSetupStep = npmPublishWorkflow
    .split(/^      - name: /m)
    .find((step) => step.startsWith("Set up pnpm\n"))

  assert.ok(pnpmSetupStep, "workflow 应包含 pnpm setup 步骤")
  assert.match(npmPublishWorkflow, /uses: actions\/checkout@v6/)
  assert.match(npmPublishWorkflow, /uses: actions\/setup-node@v6/)
  assert.match(npmPublishWorkflow, /node-version: "24\.19\.0"/)
  assert.match(npmPublishWorkflow, /test "\$\(npm --version\)" = "11\.17\.0"/)
  assert.match(pnpmSetupStep, /uses: pnpm\/action-setup@v4/)
  assert.match(pnpmSetupStep, /^\s+run_install: false$/m)
  assert.match(packageMetadata.packageManager, /^pnpm@11\.2\.2\+sha512\.[a-f0-9]+$/)
  assert.doesNotMatch(pnpmSetupStep, /^\s+version:/m)
  assert.doesNotMatch(
    npmPublishWorkflow,
    /NPM_TOKEN|NODE_AUTH_TOKEN|npm password|one-time password|\bOTP\b|\bTOTP\b/i,
  )

  assert.match(readme, /Trusted publishing/)
  assert.match(readme, /Workflow filename：`publish-npm\.yml`/)
  assert.match(readme, /不读取 `NPM_TOKEN`、npm 密码或一次性验证码/)
})

test("package checker rejects local credentials and incomplete runtime archives", async () => {
  const { gzipSync } = await import("node:zlib")
  const { inspectPackageArchive } = await import("../../scripts/check-npm-package.mjs")
  const archive = (name, body = "") => {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    header.write(Buffer.byteLength(body).toString(8).padStart(11, "0"), 124)
    header.write("0", 156)
    return gzipSync(Buffer.concat([header, Buffer.from(body), Buffer.alloc((512 - Buffer.byteLength(body) % 512) % 512), Buffer.alloc(1024)]))
  }
  assert.throws(() => inspectPackageArchive(archive("package/.env.local", "private")), /Private package entry/u)
  assert.throws(() => inspectPackageArchive(archive("package/docs/leak.md", "lin_api_" + "a".repeat(24))), /Credential-like content/u)
  assert.throws(() => inspectPackageArchive(archive("package/README.md", "Safe")), /Missing runtime file/u)
  assert.match(npmPublishWorkflow, /run: pnpm npm:check/u)
})
