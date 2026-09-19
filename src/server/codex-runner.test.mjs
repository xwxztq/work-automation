import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createAgentResultContext } from "./agent-result-runtime.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"
import {
  buildCodexPermissionBoundary,
  buildCodexRuntimeReadPaths,
  buildCodexSandboxArgs,
  resolveExecutableReadPaths,
} from "./codex-permissions.mjs"
import { buildCodexArgs, runCodex } from "./codex-runner.mjs"
import { resolveExecutable } from "./executable.mjs"

function fixture(overrides = {}) {
  return {
    config: {
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      codex: {
        defaultArgs: ["--json"],
        part1Sandbox: "danger-full-access",
        splitSandbox: "read-only",
        part2Sandbox: "workspace-write",
        part3Sandbox: "danger-full-access",
      },
      ...overrides.config,
    },
    project: { path: "/repo", codexCwd: "/repo" },
    stage: "part1",
    run: {
      dir: "/run",
      finalPath: "/run/final.txt",
      resultSchemaPath: "/run/agent-result-schema.json",
    },
    ...overrides,
  }
}

test("Codex args isolate user config and use the service-owned result schema", () => {
  const input = fixture()
  input.config.codex.defaultArgs = [
    "--json",
    "--config",
    'mcp_servers.linear.bearer_token="ARG_LINEAR_SECRET"',
    "--profile",
    "linear-profile",
    "--sandbox",
    "danger-full-access",
    "--output-last-message",
    "/tmp/other-final.txt",
    "--profile=other-profile",
    "--output-schema=/tmp/other-schema.json",
    "--sandbox=read-only",
    "--config",
    'permissions.escape.filesystem={ ":root" = "write" }',
    "--config",
    'default_permissions=":danger-full-access"',
    "--dangerously-bypass-approvals-and-sandbox",
  ]

  const args = buildCodexArgs(input)

  assert.equal(args[0], "exec")
  assert.ok(args.includes("--ignore-user-config"))
  assert.ok(args.includes("--ignore-rules"))
  assert.ok(args.includes("--ephemeral"))
  assert.ok(args.includes("--output-schema"))
  assert.ok(args.includes("/run/agent-result-schema.json"))
  assert.equal(args.filter((value) => value === "--sandbox").length, 0)
  assert.equal(args.filter((value) => value === "--output-last-message").length, 1)
  assert.equal(
    args.filter((value) => value === "--dangerously-bypass-approvals-and-sandbox")
      .length,
    1,
  )
  assert.ok(args.includes("mcp_servers={}"))
  assert.doesNotMatch(
    args.join(" "),
    /ARG_LINEAR_SECRET|danger-full-access|linear-profile|other-profile|other-schema|permissions\.escape/iu,
  )
})

test("controlled Codex environment preserves runtime auth but removes credentials and unrelated values", () => {
  const env = buildCodexProcessEnv(
    {
      PATH: "/bin",
      HOME: "/home/test",
      CODEX_HOME: "/home/test/.codex",
      OPENAI_API_KEY: "OPENAI_SENTINEL",
      HTTPS_PROXY: "http://proxy.test",
      GIT_AUTHOR_NAME: "Codex Test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LINEAR_API_KEY: "LINEAR_SENTINEL",
      MCP_LINEAR_TOKEN: "MCP_SENTINEL",
      WORK_ISSUE_TOKEN: "CUSTOM_LINEAR_SENTINEL",
      UNAUTHORIZED_SECRET: "UNAUTHORIZED_SENTINEL",
    },
    { blockedNames: ["WORK_ISSUE_TOKEN"] },
  )

  assert.equal(env.OPENAI_API_KEY, "OPENAI_SENTINEL")
  assert.equal(env.CODEX_HOME, "/home/test/.codex")
  assert.equal(env.HTTPS_PROXY, "http://proxy.test")
  assert.equal(env.GIT_AUTHOR_NAME, "Codex Test")
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null")
  assert.equal(env.LINEAR_API_KEY, undefined)
  assert.equal(env.MCP_LINEAR_TOKEN, undefined)
  assert.equal(env.WORK_ISSUE_TOKEN, undefined)
  assert.equal(env.UNAUTHORIZED_SECRET, undefined)
})

test("runtime tool paths cannot reopen the filesystem root or the whole home directory", () => {
  const paths = buildCodexRuntimeReadPaths({
    HOME: "/home/test",
    PATH: ["/", "/home/test", "/home/test/.local/bin", "/usr/bin"].join(
      path.delimiter,
    ),
    JAVA_HOME: "/",
    NODE_EXTRA_CA_CERTS: "/home/test/certs/company.pem",
  })

  assert.equal(paths.includes("/"), false)
  assert.equal(paths.includes("/home/test"), false)
  assert.ok(paths.includes("/home/test/.local/bin"))
  assert.ok(paths.includes("/usr/bin"))
  assert.ok(paths.includes("/home/test/certs/company.pem"))
})

test("macOS executable paths include resolved rpath library directories", async (t) => {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-automation-mach-runtime-"),
  )
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }))
  const executablePath = path.join(fixtureRoot, "node", "bin", "node")
  const libraryDir = path.join(fixtureRoot, "node", "lib")
  const libraryPath = path.join(libraryDir, "libnode.test.dylib")
  await fs.mkdir(path.dirname(executablePath), { recursive: true })
  await fs.mkdir(libraryDir, { recursive: true })
  await fs.writeFile(executablePath, "synthetic executable")
  await fs.writeFile(libraryPath, "synthetic library")

  const paths = await resolveExecutableReadPaths(executablePath, {
    platform: "darwin",
    async inspectMacBinary() {
      return {
        dependencies: ["@rpath/libnode.test.dylib"],
        rpaths: ["@loader_path/../lib"],
      }
    },
  })

  assert.ok(paths.includes(path.dirname(executablePath)))
  assert.ok(paths.includes(await fs.realpath(libraryPath)))
  assert.ok(paths.includes(await fs.realpath(libraryDir)))
  assert.equal(paths.includes(fixtureRoot), false)
})

test("macOS executable paths follow Homebrew library dependencies without opening private config", async (t) => {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-automation-homebrew-runtime-"),
  )
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }))
  const prefix = path.join(fixtureRoot, "homebrew")
  const nodePath = path.join(prefix, "Cellar", "node", "26.5.0", "bin", "node")
  const mervePath = path.join(
    prefix,
    "Cellar",
    "merve",
    "1.2.2",
    "lib",
    "libmerve.dylib",
  )
  const simdutfPath = path.join(
    prefix,
    "Cellar",
    "simdutf",
    "9.0.0",
    "lib",
    "libsimdutf.dylib",
  )
  const opensslPath = path.join(
    prefix,
    "Cellar",
    "openssl@3",
    "3.6.3",
    "lib",
    "libcrypto.3.dylib",
  )
  const opensslConfigPath = path.join(
    prefix,
    "etc",
    "openssl@3",
    "openssl.cnf",
  )
  const privateKeyPath = path.join(
    prefix,
    "etc",
    "openssl@3",
    "private",
    "key.pem",
  )
  for (const filePath of [
    nodePath,
    mervePath,
    simdutfPath,
    opensslPath,
    opensslConfigPath,
    privateKeyPath,
  ]) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, "synthetic runtime file")
  }
  await fs.mkdir(path.join(prefix, "opt"), { recursive: true })
  for (const [formula, version] of [
    ["merve", "1.2.2"],
    ["simdutf", "9.0.0"],
    ["openssl@3", "3.6.3"],
  ]) {
    await fs.symlink(
      path.join("..", "Cellar", formula, version),
      path.join(prefix, "opt", formula),
    )
  }

  const inspections = new Map([
    [
      await fs.realpath(nodePath),
      {
        dependencies: [
          path.join(prefix, "opt", "merve", "lib", "libmerve.dylib"),
          path.join(prefix, "opt", "openssl@3", "lib", "libcrypto.3.dylib"),
        ],
        rpaths: [],
      },
    ],
    [
      await fs.realpath(mervePath),
      {
        dependencies: [
          path.join(prefix, "opt", "simdutf", "lib", "libsimdutf.dylib"),
        ],
        rpaths: [],
      },
    ],
  ])
  const paths = await resolveExecutableReadPaths(nodePath, {
    platform: "darwin",
    async inspectMacBinary(filePath) {
      return inspections.get(filePath) || { dependencies: [], rpaths: [] }
    },
  })

  assert.ok(paths.includes(path.join(prefix, "opt")))
  assert.ok(paths.includes(path.dirname(await fs.realpath(simdutfPath))))
  assert.ok(paths.includes(opensslConfigPath))
  assert.equal(paths.includes(path.dirname(opensslConfigPath)), false)
  assert.equal(paths.includes(privateKeyPath), false)
})

test("runner filters credentials before starting the supervisor", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-runner-env-"))
  t.after(() => fs.rm(runDir, { recursive: true, force: true }))

  const supervisorCapturePath = path.join(runDir, "supervisor-env.json")
  const fakeSupervisorPath = path.join(runDir, "fake-supervisor.mjs")
  await fs.writeFile(
    fakeSupervisorPath,
    `import fs from "node:fs/promises"
const input = JSON.parse(await fs.readFile(process.argv[2], "utf8"))
const run = JSON.parse(await fs.readFile(input.metadataPath, "utf8"))
await fs.writeFile(${JSON.stringify(supervisorCapturePath)}, JSON.stringify(process.env, null, 2))
await fs.writeFile(input.metadataPath, JSON.stringify({ ...run, status: "failed", exitCode: 1, codexStarted: false, startupError: "fake supervisor" }, null, 2))
`,
  )

  const agentResultContext = createAgentResultContext({
    stage: "part2",
    projectKey: "work-automation",
    issue: { id: "issue-1172" },
  })
  const run = {
    id: "run-supervisor-env",
    dir: runDir,
    status: "running",
    promptPath: path.join(runDir, "prompt.md"),
    stdoutPath: path.join(runDir, "stdout.jsonl"),
    stderrPath: path.join(runDir, "stderr.log"),
    finalPath: path.join(runDir, "final.txt"),
    resultSchemaPath: path.join(runDir, "agent-result-schema.json"),
    metadataPath: path.join(runDir, "run.json"),
    agentResultContext,
  }
  await fs.writeFile(run.metadataPath, `${JSON.stringify(run, null, 2)}\n`)

  await runCodex({
    config: {
      linear: { apiKeyEnv: "WORK_ISSUE_TOKEN" },
      codex: {
        bin: process.execPath,
        defaultArgs: ["--json"],
        part1Sandbox: "read-only",
        splitSandbox: "read-only",
        part2Sandbox: "danger-full-access",
        part3Sandbox: "danger-full-access",
      },
    },
    project: { path: runDir, codexCwd: runDir },
    stage: "part2",
    run,
    prompt: "prompt",
    store: {
      async appendText(filePath, value) {
        await fs.appendFile(filePath, value)
      },
    },
    environment: {
      PATH: process.env.PATH,
      HOME: runDir,
      CODEX_HOME: path.join(runDir, ".codex"),
      OPENAI_API_KEY: "OPENAI_SENTINEL",
      LINEAR_API_KEY: "LINEAR_SENTINEL",
      MCP_LINEAR_TOKEN: "MCP_SENTINEL",
      WORK_ISSUE_TOKEN: "CUSTOM_LINEAR_SENTINEL",
      UNAUTHORIZED_SECRET: "UNAUTHORIZED_SENTINEL",
    },
    supervisorPath: fakeSupervisorPath,
  })

  const supervisorEnv = JSON.parse(
    await fs.readFile(supervisorCapturePath, "utf8"),
  )
  assert.equal(supervisorEnv.OPENAI_API_KEY, "OPENAI_SENTINEL")
  assert.equal(supervisorEnv.CODEX_HOME, path.join(runDir, ".codex"))
  assert.equal(supervisorEnv.LINEAR_API_KEY, undefined)
  assert.equal(supervisorEnv.MCP_LINEAR_TOKEN, undefined)
  assert.equal(supervisorEnv.WORK_ISSUE_TOKEN, undefined)
  assert.equal(supervisorEnv.UNAUTHORIZED_SECRET, undefined)
})

test("runner and supervisor keep Linear credentials out of a fake Codex process", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-runner-"))
  t.after(() => fs.rm(runDir, { recursive: true, force: true }))

  const issue = {
    id: "issue-1172",
    identifier: "LIV-1172",
    title: "Credential isolation",
    parent: { id: "issue-1170" },
  }
  const agentResultContext = createAgentResultContext({
    stage: "part2",
    projectKey: "work-automation",
    issue,
  })
  const finalValue = {
    schemaVersion: "2",
    run: {
      stage: agentResultContext.stage,
      projectKey: agentResultContext.projectKey,
      parentIssueId: agentResultContext.parentIssueId,
      allowedOperations: agentResultContext.allowedOperations,
    },
    target: agentResultContext.target,
    operations: [],
  }
  const fakeCodexPath = path.join(runDir, "fake-codex.mjs")
  const capturePath = path.join(runDir, "codex-capture.json")
  await fs.writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
const args = process.argv.slice(2)
let prompt = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) prompt += chunk
const finalIndex = args.indexOf("--output-last-message")
await fs.writeFile(args[finalIndex + 1], ${JSON.stringify(JSON.stringify(finalValue))})
await fs.writeFile(path.join(process.cwd(), "codex-capture.json"), JSON.stringify({ args, env: process.env, prompt }, null, 2))
console.log("fake stdout")
console.error("fake stderr")
`,
  )
  await fs.chmod(fakeCodexPath, 0o755)

  const run = {
    id: "run-1172",
    dir: runDir,
    status: "running",
    promptPath: path.join(runDir, "prompt.md"),
    stdoutPath: path.join(runDir, "stdout.jsonl"),
    stderrPath: path.join(runDir, "stderr.log"),
    finalPath: path.join(runDir, "final.txt"),
    resultSchemaPath: path.join(runDir, "agent-result-schema.json"),
    metadataPath: path.join(runDir, "run.json"),
    agentResultContext,
  }
  await fs.writeFile(run.metadataPath, `${JSON.stringify(run, null, 2)}\n`)

  const result = await runCodex({
    config: {
      linear: { apiKeyEnv: "WORK_ISSUE_TOKEN" },
      codex: {
        bin: fakeCodexPath,
        defaultArgs: [
          "--json",
          "--config",
          'mcp_servers.linear.bearer_token="ARG_LINEAR_SECRET"',
        ],
        part1Sandbox: "read-only",
        splitSandbox: "read-only",
        part2Sandbox: "danger-full-access",
        part3Sandbox: "danger-full-access",
      },
    },
    project: { path: runDir, codexCwd: runDir },
    stage: "part2",
    run,
    prompt: "service supplied prompt",
    store: {
      async appendText(filePath, text) {
        await fs.appendFile(filePath, text)
      },
    },
    environment: {
      PATH: process.env.PATH,
      HOME: runDir,
      CODEX_HOME: path.join(runDir, ".codex"),
      OPENAI_API_KEY: "OPENAI_SENTINEL",
      LINEAR_API_KEY: "LINEAR_SENTINEL",
      MCP_LINEAR_TOKEN: "MCP_SENTINEL",
      WORK_ISSUE_TOKEN: "CUSTOM_LINEAR_SENTINEL",
      UNAUTHORIZED_SECRET: "UNAUTHORIZED_SENTINEL",
    },
    runtimeRoot: runDir,
    sandboxExecutable: await createPassthroughSandbox(runDir),
  })

  const capture = JSON.parse(await fs.readFile(capturePath, "utf8"))
  const supervisorInput = await fs.readFile(
    path.join(runDir, "supervisor-input.json"),
    "utf8",
  )
  const supervisorConfig = JSON.parse(supervisorInput)
  const metadata = JSON.parse(await fs.readFile(run.metadataPath, "utf8"))

  assert.equal(result.status, "succeeded")
  assert.equal(result.agentResultValidation?.ok, true)
  assert.equal(capture.env.OPENAI_API_KEY, "OPENAI_SENTINEL")
  assert.equal(capture.env.CODEX_HOME, supervisorConfig.innerCodexHome)
  assert.equal(capture.env.HOME, supervisorConfig.sandboxUserHome)
  assert.equal(capture.env.TMPDIR, supervisorConfig.sandboxTempDir)
  assert.equal(capture.env.GIT_CONFIG_GLOBAL, os.devNull)
  assert.equal(capture.env.LINEAR_API_KEY, undefined)
  assert.equal(capture.env.MCP_LINEAR_TOKEN, undefined)
  assert.equal(capture.env.WORK_ISSUE_TOKEN, undefined)
  assert.equal(capture.env.UNAUTHORIZED_SECRET, undefined)
  assert.doesNotMatch(
    capture.args.join(" "),
    /ARG_LINEAR_SECRET|mcp_servers\.linear|bearer_token/iu,
  )
  assert.ok(capture.args.includes("--ignore-user-config"))
  assert.ok(capture.args.includes("--dangerously-bypass-approvals-and-sandbox"))
  assert.equal(capture.args.includes("--sandbox"), false)
  assert.ok(
    supervisorConfig.launchArgs.some((value) =>
      value.startsWith("permissions.work-automation-launcher="),
    ),
  )
  assert.ok(
    supervisorConfig.launchArgs.join(" ").includes('":root" = "deny"'),
  )
  assert.match(supervisorConfig.launchArgs.join(" "), /\.env\.local/u)
  assert.doesNotMatch(supervisorConfig.launchArgs.join(" "), /danger-full-access/u)
  assert.ok(capture.prompt.startsWith("service supplied prompt\n"))
  assert.match(capture.prompt, /browser-client\.mjs/u)
  assert.match(capture.prompt, /browser-session\.json/u)
  assert.doesNotMatch(
    supervisorInput,
    /LINEAR_SENTINEL|MCP_SENTINEL|CUSTOM_LINEAR_SENTINEL|UNAUTHORIZED_SENTINEL|ARG_LINEAR_SECRET/u,
  )
  assert.equal(
    supervisorInput.includes(JSON.stringify(path.join(runDir, ".codex"))),
    false,
  )
  assert.equal(metadata.status, "succeeded")
  assert.deepEqual(metadata.agentResult, finalValue)
  assert.match(await fs.readFile(run.stdoutPath, "utf8"), /fake stdout/u)
  assert.match(await fs.readFile(run.stderrPath, "utf8"), /fake stderr/u)
  assert.deepEqual(JSON.parse(await fs.readFile(run.finalPath, "utf8")), finalValue)
  const schema = JSON.parse(await fs.readFile(run.resultSchemaPath, "utf8"))
  assert.deepEqual(schema.properties.run.properties.stage.enum, ["part2"])
  assert.deepEqual(schema.properties.target.properties.issueId.enum, ["issue-1172"])
  await assert.rejects(fs.access(supervisorConfig.sandboxUserHome))
})

test("runner rejects macOS /tmp workspace and runtime aliases before writing or launching", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS sandbox path limitation")
  const unsafe = await fs.mkdtemp("/tmp/work-automation-unsafe-")
  const safe = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-safe-"))
  t.after(() => fs.rm(unsafe, { recursive: true, force: true }))
  t.after(() => fs.rm(safe, { recursive: true, force: true }))
  const alias = path.join(safe, "alias")
  await fs.symlink(unsafe, alias)
  for (const unsafePath of [unsafe, await fs.realpath(unsafe), alias]) {
    for (const field of ["project", "cwd", "runtime", "run"]) {
      const options = {
        config: { codex: { bin: "/must-not-launch" } },
        project: {
          path: field === "project" ? unsafePath : safe,
          codexCwd: field === "cwd" ? unsafePath : safe,
        },
        runtimeRoot: field === "runtime" ? unsafePath : safe,
        run: { dir: field === "run" ? unsafePath : safe, promptPath: path.join(safe, "must-not-write.md") },
        stage: "part1", prompt: "must not be written",
      }
      await assert.rejects(runCodex(options), /macOS Codex 沙箱无法保护 \/tmp/u)
      await assert.rejects(fs.access(options.run.promptPath))
    }
  }
})

test("real macOS sandbox permits an implementation commit only in part2", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS Seatbelt verification")
  const sandboxBin = await resolveExecutable("codex", { path: process.env.PATH })
  if (!sandboxBin) return t.skip("Codex sandbox executable is unavailable")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-git-boundary-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const projectDir = path.join(root, "project")
  const runDir = path.join(root, "run")
  const home = path.join(root, "home")
  await Promise.all([projectDir, runDir, home].map(dir => fs.mkdir(dir)))
  // Avoid /usr/bin/git's xcrun shim; it tries to cache outside the isolated HOME.
  const gitBin = await resolveExecutable("/Applications/Xcode.app/Contents/Developer/usr/bin/git") ||
    await resolveExecutable("/Library/Developer/CommandLineTools/usr/bin/git") ||
    await resolveExecutable("git")
  const init = spawnSync(gitBin, ["init", "-q", projectDir], { encoding: "utf8" })
  assert.equal(init.status, 0, init.stderr)
  await fs.writeFile(path.join(projectDir, "fixture.txt"), "implementation\n")
  await fs.writeFile(path.join(projectDir, ".env.local"), "SYNTHETIC_SECRET=test\n")
  for (const stage of ["part1", "split", "part2", "part3"]) {
    const boundary = buildCodexPermissionBoundary({
      stage, cwd: projectDir, projectPath: projectDir, runtimeRoot: root,
      runDir, finalPath: path.join(runDir, "final.txt"),
      runtimeReadPaths: [path.dirname(process.execPath), path.dirname(gitBin)],
      runtimeWritePaths: [home],
    })
    const command = stage === "part2"
      ? `const {spawnSync}=require('node:child_process');const git=${JSON.stringify(gitBin)};for(const args of [['add','fixture.txt'],['-c','user.name=Sandbox Test','-c','user.email=sandbox@example.test','commit','--no-gpg-sign','-m','test: scoped commit']]){const r=spawnSync(git,args,{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);}`
      : `let denied=false;try{require('node:fs').writeFileSync('.git/write-probe','forbidden')}catch(e){denied=/EPERM|EACCES/.test(e.code)}require('node:assert/strict').ok(denied);`
    const script = `{let denied=false;try{require('node:fs').readFileSync('.env.local')}catch(e){denied=/EPERM|EACCES/.test(e.code)}require('node:assert/strict').ok(denied);}${command}`
    const result = spawnSync(sandboxBin, buildCodexSandboxArgs({
      boundary, cwd: projectDir, targetBin: process.execPath, targetArgs: ["-e", script],
    }), { cwd: projectDir, encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: home, TMPDIR: home, GIT_CONFIG_GLOBAL: os.devNull } })
    assert.equal(result.status, 0, `${stage}: ${result.stderr}`)
  }
  const log = spawnSync(gitBin, ["log", "-1", "--format=%s"], { cwd: projectDir, encoding: "utf8" })
  assert.equal(log.stdout.trim(), "test: scoped commit")
  await assert.rejects(fs.access(path.join(projectDir, ".git", "write-probe")))
})

test("real macOS sandbox denies the Codex process access to service credentials and keeps review writable", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Seatbelt verification")
    return
  }
  const sandboxBin = await resolveExecutable("codex", { path: process.env.PATH })
  if (!sandboxBin) {
    t.skip("Codex sandbox executable is unavailable")
    return
  }

  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-automation-filesystem-boundary-"),
  )
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }))
  const projectDir = path.join(fixtureRoot, "work-automation")
  const runtimeRoot = projectDir
  const runDir = path.join(
    runtimeRoot,
    ".linear-automation",
    "runs",
    "run-filesystem-boundary",
  )
  const reviewDir = path.join(runDir, "review")
  const credentialPath = path.join(runtimeRoot, ".env.local")
  const configPath = path.join(runtimeRoot, "config.local.json")
  const otherRunPath = path.join(
    runtimeRoot,
    ".linear-automation",
    "runs",
    "other-run",
    "run.json",
  )
  const projectWritePath = path.join(projectDir, "sandbox-write-probe.txt")
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(runDir, { recursive: true })
  await fs.mkdir(path.dirname(otherRunPath), { recursive: true })
  await fs.writeFile(
    credentialPath,
    "LINEAR_API_KEY=FILESYSTEM_LINEAR_SENTINEL\n",
    { mode: 0o600 },
  )
  await fs.writeFile(configPath, '{"sentinel":"CONFIG_SENTINEL"}\n')
  await fs.writeFile(otherRunPath, '{"sentinel":"OTHER_RUN_SENTINEL"}\n')

  const issue = {
    id: "issue-1172",
    identifier: "LIV-1172",
    title: "Credential isolation",
    parent: { id: "issue-1170" },
  }
  const agentResultContext = createAgentResultContext({
    stage: "part3",
    projectKey: "work-automation",
    issue,
  })
  const finalValue = {
    schemaVersion: "2",
    run: {
      stage: agentResultContext.stage,
      projectKey: agentResultContext.projectKey,
      parentIssueId: agentResultContext.parentIssueId,
      allowedOperations: agentResultContext.allowedOperations,
    },
    target: agentResultContext.target,
    operations: [],
  }
  const fakeCodexPath = path.join(projectDir, "fake-codex.mjs")
  await fs.writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
const args = process.argv.slice(2)
process.stdin.resume()
await new Promise((resolve) => process.stdin.once("end", resolve))
const probeRead = async (filePath) => {
  try {
    await fs.readFile(filePath, "utf8")
    return { allowed: true, errorCode: null }
  } catch (error) {
    return { allowed: false, errorCode: error?.code || null }
  }
}
const probeWrite = async (filePath) => {
  try {
    await fs.writeFile(filePath, "synthetic write probe")
    return { allowed: true, errorCode: null }
  } catch (error) {
    return { allowed: false, errorCode: error?.code || null }
  }
}
const credentialRead = await probeRead(${JSON.stringify(credentialPath)})
const configRead = await probeRead(${JSON.stringify(configPath)})
const otherRunRead = await probeRead(${JSON.stringify(otherRunPath)})
const projectWrite = await probeWrite(${JSON.stringify(projectWritePath)})
const gitIdentityUsable = await new Promise((resolve) => {
  const child = spawn("git", ["var", "GIT_AUTHOR_IDENT"], { stdio: "ignore" })
  child.once("error", () => resolve(false))
  child.once("close", (code) => resolve(code === 0))
})
const finalIndex = args.indexOf("--output-last-message")
await fs.writeFile(args[finalIndex + 1], ${JSON.stringify(JSON.stringify(finalValue))})
await fs.mkdir(${JSON.stringify(reviewDir)}, { recursive: true })
await fs.writeFile(path.join(${JSON.stringify(reviewDir)}, "filesystem-boundary.json"), JSON.stringify({ credentialRead, configRead, otherRunRead, projectWrite, gitIdentityUsable, reviewWritable: true }, null, 2))
console.log("sandboxed fake stdout")
console.error("sandboxed fake stderr")
`,
  )
  await fs.chmod(fakeCodexPath, 0o755)

  const run = {
    id: "run-filesystem-boundary",
    dir: runDir,
    status: "running",
    promptPath: path.join(runDir, "prompt.md"),
    stdoutPath: path.join(runDir, "stdout.jsonl"),
    stderrPath: path.join(runDir, "stderr.log"),
    finalPath: path.join(runDir, "final.txt"),
    resultSchemaPath: path.join(runDir, "agent-result-schema.json"),
    metadataPath: path.join(runDir, "run.json"),
    agentResultContext,
  }
  await fs.writeFile(run.metadataPath, `${JSON.stringify(run, null, 2)}\n`)

  const result = await runCodex({
    config: {
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      codex: {
        bin: fakeCodexPath,
        defaultArgs: ["--json"],
        part1Sandbox: "read-only",
        splitSandbox: "read-only",
        part2Sandbox: "workspace-write",
        part3Sandbox: "workspace-write",
      },
    },
    project: { path: projectDir, codexCwd: projectDir },
    stage: "part3",
    run,
    runtimeRoot,
    prompt: "service supplied prompt",
    store: {
      async appendText(filePath, text) {
        await fs.appendFile(filePath, text)
      },
    },
    environment: {
      ...process.env,
      GIT_AUTHOR_NAME: "Codex Test",
      GIT_AUTHOR_EMAIL: "codex-test@example.test",
      GIT_COMMITTER_NAME: "Codex Test",
      GIT_COMMITTER_EMAIL: "codex-test@example.test",
      LINEAR_API_KEY: "LINEAR_ENV_SENTINEL",
      MCP_LINEAR_TOKEN: "MCP_ENV_SENTINEL",
    },
    sandboxExecutable: sandboxBin,
  })

  assert.equal(
    result.status,
    "succeeded",
    await fs.readFile(run.stderrPath, "utf8").catch(() => "no stderr"),
  )
  const evidence = JSON.parse(
    await fs.readFile(path.join(reviewDir, "filesystem-boundary.json"), "utf8"),
  )
  for (const probe of [
    evidence.credentialRead,
    evidence.configRead,
    evidence.otherRunRead,
    evidence.projectWrite,
  ]) {
    assert.equal(probe.allowed, false)
    assert.match(probe.errorCode || "", /EACCES|EPERM/u)
  }
  assert.equal(evidence.gitIdentityUsable, true)
  assert.equal(evidence.reviewWritable, true)
  await assert.rejects(fs.access(projectWritePath))
  assert.match(await fs.readFile(run.stdoutPath, "utf8"), /sandboxed fake stdout/u)
  assert.match(await fs.readFile(run.stderrPath, "utf8"), /sandboxed fake stderr/u)
  const supervisorConfig = JSON.parse(
    await fs.readFile(path.join(runDir, "supervisor-input.json"), "utf8"),
  )
  await assert.rejects(fs.access(supervisorConfig.sandboxUserHome))
})

test("real Codex executable remains launchable inside the restricted outer profile", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Seatbelt verification")
    return
  }
  const codexBin = await resolveExecutable("codex", { path: process.env.PATH })
  if (!codexBin) {
    t.skip("Codex sandbox executable is unavailable")
    return
  }

  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-automation-codex-launch-"),
  )
  t.after(() => fs.rm(runDir, { recursive: true, force: true }))
  const sandboxUserHome = path.join(runDir, "user-home")
  const sandboxTempDir = path.join(sandboxUserHome, "tmp")
  const launcherHome = path.join(sandboxUserHome, "launcher-home")
  await fs.mkdir(sandboxTempDir, { recursive: true })
  await fs.mkdir(launcherHome)
  const environment = {
    ...process.env,
    CODEX_HOME: launcherHome,
    HOME: sandboxUserHome,
    TMPDIR: sandboxTempDir,
    TMP: sandboxTempDir,
    TEMP: sandboxTempDir,
  }
  const boundary = buildCodexPermissionBoundary({
    stage: "part1",
    cwd: process.cwd(),
    projectPath: process.cwd(),
    runtimeRoot: process.cwd(),
    runDir,
    finalPath: path.join(runDir, "final.txt"),
    runtimeReadPaths: buildCodexRuntimeReadPaths(environment),
    launcherReadPaths: await resolveExecutableReadPaths(codexBin),
    runtimeWritePaths: [sandboxUserHome],
  })
  const args = buildCodexSandboxArgs({
    boundary,
    cwd: process.cwd(),
    targetBin: codexBin,
    targetArgs: ["--version"],
  })
  const result = await spawnCapture(codexBin, args, environment)

  assert.equal(result.code, 0, result.stderr)
  assert.match(`${result.stdout}\n${result.stderr}`, /codex-cli\s+\d+/u)
})

async function createPassthroughSandbox(rootDir) {
  const sandboxPath = path.join(rootDir, "fake-sandbox.mjs")
  await fs.writeFile(
    sandboxPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process"
const separator = process.argv.indexOf("--")
if (separator === -1 || !process.argv[separator + 1]) process.exit(2)
const child = spawn(process.argv[separator + 1], process.argv.slice(separator + 2), { env: process.env, stdio: "inherit" })
child.once("error", (error) => { console.error(error); process.exit(1) })
child.once("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
`,
  )
  await fs.chmod(sandboxPath, 0o755)
  return sandboxPath
}

function spawnCapture(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}
