import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createAgentResultContext } from "./agent-result-runtime.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"
import { buildCodexArgs, runCodex } from "./codex-runner.mjs"

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
  ]

  const args = buildCodexArgs(input)

  assert.equal(args[0], "exec")
  assert.ok(args.includes("--ignore-user-config"))
  assert.ok(args.includes("--output-schema"))
  assert.ok(args.includes("/run/agent-result-schema.json"))
  assert.equal(args.filter((value) => value === "--sandbox").length, 1)
  assert.equal(args.filter((value) => value === "--output-last-message").length, 1)
  assert.doesNotMatch(
    args.join(" "),
    /mcp_servers|ARG_LINEAR_SECRET|linear-profile|other-profile|other-schema/iu,
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
  assert.equal(env.LINEAR_API_KEY, undefined)
  assert.equal(env.MCP_LINEAR_TOKEN, undefined)
  assert.equal(env.WORK_ISSUE_TOKEN, undefined)
  assert.equal(env.UNAUTHORIZED_SECRET, undefined)
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
  })

  const capture = JSON.parse(await fs.readFile(capturePath, "utf8"))
  const supervisorInput = await fs.readFile(
    path.join(runDir, "supervisor-input.json"),
    "utf8",
  )
  const metadata = JSON.parse(await fs.readFile(run.metadataPath, "utf8"))

  assert.equal(result.status, "succeeded")
  assert.equal(result.agentResultValidation?.ok, true)
  assert.equal(capture.env.OPENAI_API_KEY, "OPENAI_SENTINEL")
  assert.equal(capture.env.CODEX_HOME, path.join(runDir, ".codex"))
  assert.equal(capture.env.LINEAR_API_KEY, undefined)
  assert.equal(capture.env.MCP_LINEAR_TOKEN, undefined)
  assert.equal(capture.env.WORK_ISSUE_TOKEN, undefined)
  assert.equal(capture.env.UNAUTHORIZED_SECRET, undefined)
  assert.doesNotMatch(capture.args.join(" "), /mcp_servers|ARG_LINEAR_SECRET/iu)
  assert.ok(capture.args.includes("--ignore-user-config"))
  assert.equal(capture.prompt, "service supplied prompt")
  assert.doesNotMatch(
    supervisorInput,
    /LINEAR_SENTINEL|MCP_SENTINEL|CUSTOM_LINEAR_SENTINEL|UNAUTHORIZED_SENTINEL|ARG_LINEAR_SECRET/u,
  )
  assert.equal(metadata.status, "succeeded")
  assert.deepEqual(metadata.agentResult, finalValue)
  assert.match(await fs.readFile(run.stdoutPath, "utf8"), /fake stdout/u)
  assert.match(await fs.readFile(run.stderrPath, "utf8"), /fake stderr/u)
  assert.deepEqual(JSON.parse(await fs.readFile(run.finalPath, "utf8")), finalValue)
  const schema = JSON.parse(await fs.readFile(run.resultSchemaPath, "utf8"))
  assert.deepEqual(schema.properties.run.properties.stage.enum, ["part2"])
  assert.deepEqual(schema.properties.target.properties.issueId.enum, ["issue-1172"])
})
