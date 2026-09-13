import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createAgentResultContext } from "./agent-result-runtime.mjs"

const supervisorPath = fileURLToPath(new URL("./codex-supervisor.mjs", import.meta.url))
const sandboxTargetPath = fileURLToPath(
  new URL("./codex-sandbox-target.mjs", import.meta.url),
)

test("validates a fake Codex result, filters its environment, and preserves run artifacts", async (t) => {
  const fixture = await createSupervisorFixture({ cleanupReview: true })
  t.after(() => cleanupFixture(fixture))

  const reviewDir = path.join(fixture.runDir, "review")
  await fs.mkdir(path.join(reviewDir, "_work", "node_modules", "package"), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(reviewDir, "_work", "node_modules", "package", "index.js"),
    "temp",
  )
  await fs.writeFile(path.join(reviewDir, "summary.md"), "keep")

  const exitCode = await runSupervisor(fixture.inputPath, {
    ...process.env,
    OPENAI_API_KEY: "OPENAI_SENTINEL",
    LINEAR_API_KEY: "LINEAR_SENTINEL",
    MCP_LINEAR_TOKEN: "MCP_SENTINEL",
    WORK_ISSUE_TOKEN: "CUSTOM_LINEAR_SENTINEL",
    UNAUTHORIZED_SECRET: "UNAUTHORIZED_SENTINEL",
    CODEX_HOME: fixture.sourceCodexHome,
  })
  const run = JSON.parse(await fs.readFile(fixture.metadataPath, "utf8"))
  const capture = JSON.parse(await fs.readFile(fixture.capturePath, "utf8"))
  const launcherCapture = JSON.parse(
    await fs.readFile(fixture.launcherCapturePath, "utf8"),
  )

  assert.equal(exitCode, 0)
  assert.equal(run.status, "succeeded")
  assert.equal(run.agentResultValidation.ok, true)
  assert.deepEqual(run.agentResult, fixture.finalValue)
  assert.equal(launcherCapture.env.CODEX_HOME, fixture.launcherCodexHome)
  assert.equal(launcherCapture.env.HOME, fixture.sandboxUserHome)
  assert.equal(launcherCapture.env.TMPDIR, fixture.sandboxTempDir)
  assert.equal(capture.env.OPENAI_API_KEY, "OPENAI_SENTINEL")
  assert.equal(capture.env.CODEX_HOME, fixture.innerCodexHome)
  assert.equal(capture.env.HOME, fixture.sandboxUserHome)
  assert.equal(capture.env.TMPDIR, fixture.sandboxTempDir)
  assert.equal(capture.env.GIT_CONFIG_GLOBAL, os.devNull)
  assert.equal(capture.authPresent, true)
  assert.equal(capture.env.LINEAR_API_KEY, undefined)
  assert.equal(capture.env.MCP_LINEAR_TOKEN, undefined)
  assert.equal(capture.env.WORK_ISSUE_TOKEN, undefined)
  assert.equal(capture.env.UNAUTHORIZED_SECRET, undefined)
  assert.deepEqual(run.reviewCleanup.removedEntries, ["_work"])
  await assert.rejects(fs.lstat(path.join(reviewDir, "_work")), { code: "ENOENT" })
  assert.equal(await fs.readFile(path.join(reviewDir, "summary.md"), "utf8"), "keep")
  assert.match(await fs.readFile(fixture.stdoutPath, "utf8"), /fake stdout/u)
  assert.match(await fs.readFile(fixture.stderrPath, "utf8"), /fake stderr/u)
  assert.doesNotMatch(
    await fs.readFile(fixture.inputPath, "utf8"),
    /SYNTHETIC_CODEX_AUTH_SENTINEL/u,
  )
  await assert.rejects(fs.access(fixture.launcherCodexHome), { code: "ENOENT" })
})

test("fails closed when Codex exits zero with an invalid structured result", async (t) => {
  const fixture = await createSupervisorFixture({
    finalTransform(value) {
      return {
        ...value,
        schemaVersion: "999",
        operations: [
          {
            type: "comment.create",
            idempotencyKey: "issue-1172:part2:comment",
            payload: { body: "FINAL_RESULT_SENTINEL" },
          },
        ],
      }
    },
  })
  t.after(() => cleanupFixture(fixture))

  const exitCode = await runSupervisor(fixture.inputPath, {
    ...process.env,
    CODEX_HOME: fixture.sourceCodexHome,
  })
  const metadataText = await fs.readFile(fixture.metadataPath, "utf8")
  const run = JSON.parse(metadataText)
  const stderr = await fs.readFile(fixture.stderrPath, "utf8")

  assert.equal(exitCode, 0)
  assert.equal(run.exitCode, 0)
  assert.equal(run.status, "failed")
  assert.equal(run.agentResultValidation.ok, false)
  assert.equal(run.agentResultValidation.error.code, "UNKNOWN_VERSION")
  assert.equal(run.agentResult, undefined)
  assert.match(run.error, /UNKNOWN_VERSION/u)
  assert.doesNotMatch(run.error, /999|FINAL_RESULT_SENTINEL/u)
  assert.doesNotMatch(metadataText, /FINAL_RESULT_SENTINEL/u)
  assert.doesNotMatch(stderr, /999|FINAL_RESULT_SENTINEL/u)
  assert.match(
    await fs.readFile(fixture.finalPath, "utf8"),
    /FINAL_RESULT_SENTINEL/u,
  )
})

async function createSupervisorFixture(options = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-supervisor-"))
  const metadataPath = path.join(runDir, "run.json")
  const promptPath = path.join(runDir, "prompt.md")
  const stdoutPath = path.join(runDir, "stdout.jsonl")
  const stderrPath = path.join(runDir, "stderr.log")
  const finalPath = path.join(runDir, "final.txt")
  const resultSchemaPath = path.join(runDir, "agent-result-schema.json")
  const inputPath = path.join(runDir, "supervisor-input.json")
  const capturePath = path.join(runDir, "codex-capture.json")
  const fakeCodexPath = path.join(runDir, "fake-codex.mjs")
  const fakeLauncherPath = path.join(runDir, "fake-sandbox-launcher.mjs")
  const launcherCapturePath = path.join(runDir, "launcher-capture.json")
  const sandboxUserHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-automation-codex-"),
  )
  const sandboxTempDir = path.join(sandboxUserHome, "tmp")
  const launcherCodexHome = path.join(sandboxUserHome, ".codex-launcher")
  const innerCodexHome = path.join(sandboxUserHome, ".codex-runtime")
  const sourceCodexHome = path.join(runDir, "source-codex-home")
  const agentResultContext = createAgentResultContext({
    stage: "part2",
    projectKey: "work-automation",
    issue: {
      id: "issue-1172",
      parent: { id: "issue-1170" },
    },
  })
  const baseFinalValue = {
    schemaVersion: agentResultContext.schemaVersion,
    run: {
      stage: agentResultContext.stage,
      projectKey: agentResultContext.projectKey,
      parentIssueId: agentResultContext.parentIssueId,
      allowedOperations: agentResultContext.allowedOperations,
    },
    target: agentResultContext.target,
    operations: [],
  }
  const finalValue = options.finalTransform
    ? options.finalTransform(baseFinalValue)
    : baseFinalValue

  await fs.writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
const args = process.argv.slice(2)
let prompt = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) prompt += chunk
const authPresent = await fs.access(path.join(process.env.CODEX_HOME, "auth.json")).then(() => true, () => false)
const finalIndex = args.indexOf("--output-last-message")
await fs.writeFile(args[finalIndex + 1], ${JSON.stringify(JSON.stringify(finalValue))})
await fs.writeFile(path.join(process.cwd(), "codex-capture.json"), JSON.stringify({ args, authPresent, env: process.env, prompt }, null, 2))
console.log("fake stdout")
console.error("fake stderr")
`,
  )
  await fs.chmod(fakeCodexPath, 0o755)
  await fs.mkdir(sourceCodexHome)
  await fs.writeFile(
    path.join(sourceCodexHome, "auth.json"),
    '{"token":"SYNTHETIC_CODEX_AUTH_SENTINEL"}\n',
    { mode: 0o600 },
  )
  await fs.writeFile(
    fakeLauncherPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
const args = process.argv.slice(2)
await fs.writeFile(${JSON.stringify(launcherCapturePath)}, JSON.stringify({ args, env: process.env }, null, 2))
const child = spawn(args[0], args.slice(1), { env: process.env, stdio: "inherit" })
child.once("error", (error) => { console.error(error); process.exit(1) })
child.once("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
`,
  )
  await fs.chmod(fakeLauncherPath, 0o755)
  await fs.writeFile(promptPath, "prompt")
  await fs.writeFile(resultSchemaPath, "{}\n")
  await fs.writeFile(
    metadataPath,
    JSON.stringify({
      id: "run-1",
      status: "running",
      cleanupReviewTempOnCompletion: Boolean(options.cleanupReview),
      agentResultContext,
    }),
  )
  await fs.writeFile(
    inputPath,
    JSON.stringify({
      codexBin: fakeCodexPath,
      args: [
        "exec",
        "--ignore-user-config",
        "--output-last-message",
        finalPath,
        "--output-schema",
        resultSchemaPath,
        "-",
      ],
      launchBin: fakeLauncherPath,
      launchArgs: [process.execPath, sandboxTargetPath, inputPath],
      cwd: runDir,
      promptPath,
      stdoutPath,
      stderrPath,
      finalPath,
      resultSchemaPath,
      metadataPath,
      agentResultContext,
      blockedEnvironmentNames: ["WORK_ISSUE_TOKEN"],
      launcherCodexHome,
      innerCodexHome,
      sandboxUserHome,
      sandboxTempDir,
    }),
  )

  return {
    runDir,
    metadataPath,
    stdoutPath,
    stderrPath,
    finalPath,
    inputPath,
    capturePath,
    launcherCapturePath,
    launcherCodexHome,
    innerCodexHome,
    sourceCodexHome,
    sandboxUserHome,
    sandboxTempDir,
    finalValue,
  }
}

function runSupervisor(inputPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisorPath, inputPath], {
      env,
      stdio: "ignore",
    })
    child.once("error", reject)
    child.once("close", (code) => resolve(code))
  })
}

async function cleanupFixture(fixture) {
  await Promise.all([
    fs.rm(fixture.runDir, { recursive: true, force: true }),
    fs.rm(fixture.sandboxUserHome, { recursive: true, force: true }),
  ])
}
