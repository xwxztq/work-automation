import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { buildCodexPermissionBoundary, buildCodexSandboxArgs, prepareCodexSandboxOutputs } from "./codex-permissions.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"
import { resolveExecutable } from "./executable.mjs"
import { buildCodexSandboxTargetArgs } from "./codex-runner.mjs"
import { buildWindowsNodeOptions, formatNodeCommand } from "./windows-node-runtime.mjs"

test("Windows Node compatibility is scoped and command examples use PowerShell invocation", () => {
  assert.equal(buildWindowsNodeOptions("linux"), undefined)
  assert.equal(buildWindowsNodeOptions("darwin"), undefined)
  assert.match(buildWindowsNodeOptions("win32"), /^--preserve-symlinks-main --import=data:/u)
  assert.equal(formatNodeCommand(["C:\\a'b\\client.mjs", "run"], { platform: "win32", execPath: "C:\\Program Files\\node.exe" }), "& 'C:\\Program Files\\node.exe' 'C:\\a''b\\client.mjs' 'run'")
})

test("isolated Windows launches choose a backend supporting restricted reads", () => {
  const options = { boundary: { launcher: { name: "restricted", configArgs: [] } }, cwd: process.cwd(), targetBin: "node", targetArgs: ["--version"] }
  const args = buildCodexSandboxArgs({ ...options, platform: "win32" })
  assert.ok(args.includes("features.prefer_mxc=true"))
  assert.ok(args.includes('windows.sandbox="elevated"'))
  assert.ok(args.includes("restricted"))
  for (const platform of ["darwin", "linux"]) {
    assert.equal(buildCodexSandboxArgs({ ...options, platform }).some(value => /windows\.sandbox|prefer_mxc/u.test(value)), false)
  }
})

test("Windows output preparation preserves existing results and creates the progress write root", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-output-test-"))
  const finalPath = path.join(runDir, "final.txt")
  try {
    await prepareCodexSandboxOutputs({ stage: "superpower", runDir, finalPath, platform: "win32" })
    assert.equal(await fs.readFile(finalPath, "utf8"), "")
    assert.ok((await fs.stat(path.join(runDir, "progress", "requests"))).isDirectory())
    await fs.writeFile(finalPath, "existing result")
    await prepareCodexSandboxOutputs({ stage: "superpower", runDir, finalPath, platform: "win32" })
    assert.equal(await fs.readFile(finalPath, "utf8"), "existing result")
  } finally {
    await fs.rm(runDir, { recursive: true, force: true })
  }
})

test("real Windows sandbox enforces the WA boundary and launches nested Codex", { skip: process.platform !== "win32" || process.env.WAUTO_WINDOWS_SANDBOX_LIVE_TEST !== "1" }, async () => {
  const codex = await resolveExecutable("codex.exe", { path: process.env.PATH })
  assert.ok(codex, "Codex must be installed for the live sandbox check")
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "wa-boundary-test-"))
  try {
    const project = path.join(fixture, "project")
    const service = path.join(fixture, "service")
    const runDir = path.join(service, "runs", "fixture")
    const home = path.join(fixture, "home")
    const temp = path.join(home, "tmp")
    const codexHome = path.join(home, ".codex")
    await Promise.all([project, runDir, temp, codexHome].map(dir => fs.mkdir(dir, { recursive: true })))
    await fs.writeFile(path.join(project, "allowed.txt"), "allowed")
    await fs.writeFile(path.join(project, ".env"), "test-only secret")
    await fs.writeFile(path.join(service, ".env.local"), "test-only service secret")
    await fs.writeFile(path.join(runDir, "supervisor-input.json"), "{}")
    const finalPath = path.join(runDir, "final.txt")
    const inputPath = path.join(runDir, "supervisor-input.json")
    const wrapperArgs = buildCodexSandboxTargetArgs(inputPath)
    const wrapperPath = wrapperArgs.at(-2)
    await fs.writeFile(inputPath, JSON.stringify({ codexBin: codex, args: ["--version"], cwd: project, innerCodexHome: codexHome }))
    const env = { ...buildCodexProcessEnv(process.env), HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, TMP: temp, TEMP: temp, TMPDIR: temp }
    for (const stage of ["part1", "superpower"]) {
      await prepareCodexSandboxOutputs({ stage, runDir, finalPath })
      await fs.mkdir(path.join(runDir, "review"), { recursive: true })
      const boundary = buildCodexPermissionBoundary({ stage, cwd: project, projectPath: project, runtimeRoot: service, runDir, finalPath, runtimeWritePaths: [home], launcherReadPaths: [path.dirname(process.execPath), path.dirname(codex), wrapperPath] })
      const wrapperResult = spawnSync(codex, buildCodexSandboxArgs({ boundary, cwd: project, targetBin: process.execPath, targetArgs: wrapperArgs }), { cwd: project, env, encoding: "utf8", windowsHide: true, timeout: 45000 })
      assert.equal(wrapperResult.status, 0, `${stage} production wrapper: ${wrapperResult.stderr}`)
      assert.match(wrapperResult.stdout, /codex-cli/u)
      const probe = `
        const fs=require('fs'), assert=require('assert/strict'), {spawnSync}=require('child_process');
        assert.equal(fs.readFileSync('allowed.txt','utf8'),'allowed');
        for(const p of ['.env',${JSON.stringify(path.join(service, ".env.local"))}]) assert.throws(()=>fs.readFileSync(p));
        assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(runDir, "supervisor-input.json"))},'changed'));
        ${stage === "part1" ? "assert.throws(()=>fs.writeFileSync('forbidden.txt','x'));" : `fs.writeFileSync('implementation.txt','ok'); fs.writeFileSync(${JSON.stringify(path.join(runDir, "progress", "requests", "probe.json"))},'{}'); fs.writeFileSync(${JSON.stringify(path.join(runDir, "review", "probe.txt"))},'ok');`}
        fs.writeFileSync(${JSON.stringify(finalPath)},'result');
        const child=spawnSync(${JSON.stringify(codex)},['--version'],{encoding:'utf8',windowsHide:true});
        assert.equal(child.status,0,child.stderr); assert.match(child.stdout,/codex-cli/);
        console.log('BOUNDARY_OK');
      `
      const args = buildCodexSandboxArgs({ boundary, cwd: project, targetBin: process.execPath, targetArgs: ["-e", probe] })
      const result = spawnSync(codex, args, { cwd: project, env, encoding: "utf8", windowsHide: true, timeout: 45000 })
      assert.equal(result.status, 0, `${stage}: ${result.error?.message || ""}\n${result.stderr}`)
      assert.match(result.stdout, /BOUNDARY_OK/u)
      assert.equal(await fs.readFile(finalPath, "utf8"), "result")
    }

    // Exercise normal module loading (not node -e): pnpm and dependency loaders
    // explicitly call realpath, so preserving entry symlinks alone is insufficient.
    const nativeEnv = { ...env, NODE_OPTIONS: buildWindowsNodeOptions() }
    const packageDir = path.join(project, "store", "entry")
    const dependencyDir = path.join(project, "store", "node_modules", "dep")
    await fs.mkdir(packageDir, { recursive: true })
    await fs.mkdir(dependencyDir, { recursive: true })
    await fs.mkdir(path.join(project, "node_modules"), { recursive: true })
    await fs.writeFile(path.join(packageDir, "index.js"), "module.exports = require('dep')")
    await fs.writeFile(path.join(dependencyDir, "index.js"), "module.exports = 'DEPENDENCY_OK'")
    await fs.symlink(packageDir, path.join(project, "node_modules", "entry"), "junction")
    const mainPath = path.join(project, "native-probe.cjs")
    await fs.writeFile(mainPath, `const fs=require('fs'),assert=require('assert/strict');assert.ok(fs.realpathSync(process.env.TEMP));assert.equal(require('entry'),'DEPENDENCY_OK');assert.throws(()=>fs.readFileSync('.env'));assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(service, ".env.local"))}));console.log('NATIVE_PATH_OK')`)
    const pnpmPath = path.resolve(process.execPath, "../../node_modules/pnpm/bin/pnpm.mjs")
    const nativeBoundary = buildCodexPermissionBoundary({ stage: "superpower", cwd: project, projectPath: project, runtimeRoot: service, runDir, finalPath, runtimeWritePaths: [home], launcherReadPaths: [path.dirname(process.execPath), path.resolve(pnpmPath, "../..")] })
    const nativeResult = spawnSync(codex, buildCodexSandboxArgs({ boundary: nativeBoundary, cwd: project, targetBin: process.execPath, targetArgs: [mainPath] }), { cwd: project, env: nativeEnv, encoding: "utf8", windowsHide: true, timeout: 45000 })
    assert.equal(nativeResult.status, 0, nativeResult.stderr)
    assert.match(nativeResult.stdout, /NATIVE_PATH_OK/u)

    const pnpmPackage = await fs.readFile(path.resolve(pnpmPath, "../../package.json"), "utf8").then(JSON.parse).catch(() => null)
    if (pnpmPackage) {
      await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ name: "wa-sandbox-probe", private: true, packageManager: `pnpm@${pnpmPackage.version}`, scripts: { probe: "node native-probe.cjs" } }))
      await fs.writeFile(path.join(project, "pnpm-workspace.yaml"), "packages: []\nverifyDepsBeforeRun: false\n")
      nativeEnv.PATH = `${path.dirname(process.execPath)}${path.delimiter}${nativeEnv.PATH || ""}`
      const pnpmResult = spawnSync(codex, buildCodexSandboxArgs({ boundary: nativeBoundary, cwd: project, targetBin: process.execPath, targetArgs: [pnpmPath, "run", "probe"] }), { cwd: project, env: nativeEnv, encoding: "utf8", windowsHide: true, timeout: 45000 })
      assert.equal(pnpmResult.status, 0, `${pnpmResult.stdout}\n${pnpmResult.stderr}`)
      assert.match(pnpmResult.stdout, /NATIVE_PATH_OK/u)
    }
  } finally {
    // Only delete the exact fixture created under the OS temporary directory.
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()))
    assert.ok(path.basename(fixture).startsWith("wa-boundary-test-"))
    await fs.rm(fixture, { recursive: true, force: true })
  }
})
