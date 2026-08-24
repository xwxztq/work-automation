import assert from "node:assert/strict"
import { spawn } from "node:child_process"
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
    schemaVersion: "1",
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
  assert.equal(capture.prompt, "service supplied prompt")
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
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(
    credentialPath,
    "LINEAR_API_KEY=FILESYSTEM_LINEAR_SENTINEL\n",
    { mode: 0o600 },
  )

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
    schemaVersion: "1",
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
let credentialReadable = true
let credentialErrorCode = null
try {
  await fs.readFile(${JSON.stringify(credentialPath)}, "utf8")
} catch (error) {
  credentialReadable = false
  credentialErrorCode = error?.code || null
}
const gitIdentityUsable = await new Promise((resolve) => {
  const child = spawn("git", ["var", "GIT_AUTHOR_IDENT"], { stdio: "ignore" })
  child.once("error", () => resolve(false))
  child.once("close", (code) => resolve(code === 0))
})
const finalIndex = args.indexOf("--output-last-message")
await fs.writeFile(args[finalIndex + 1], ${JSON.stringify(JSON.stringify(finalValue))})
await fs.mkdir(${JSON.stringify(reviewDir)}, { recursive: true })
await fs.writeFile(path.join(${JSON.stringify(reviewDir)}, "filesystem-boundary.json"), JSON.stringify({ credentialReadable, credentialErrorCode, gitIdentityUsable, reviewWritable: true }, null, 2))
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
  assert.equal(evidence.credentialReadable, false)
  assert.match(evidence.credentialErrorCode || "", /EACCES|EPERM/u)
  assert.equal(evidence.gitIdentityUsable, true)
  assert.equal(evidence.reviewWritable, true)
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
