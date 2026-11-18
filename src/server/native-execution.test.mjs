import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createAgentResultContext } from "./agent-result-runtime.mjs"
import { runCodex } from "./codex-runner.mjs"

for (const stage of ["part1", "split", "part2", "part3"]) {
  test(`native ${stage} preserves user tools with Codex approvals and the service result protocol`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wauto-native-test-"))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, "workspace")
    const hostHome = path.join(root, "home")
    const hostTemp = path.join(root, "temp")
    const runDir = path.join(root, "run")
    await Promise.all([workspace, hostHome, hostTemp, runDir].map(p => fs.mkdir(p)))
    const sibling = path.join(root, "reference.txt")
    await fs.writeFile(sibling, "reference-repo")
    const context = createAgentResultContext({ stage, projectKey: "native", issue: { id: "test" } })
    const final = { schemaVersion: "2", run: {
      stage, projectKey: "native", parentIssueId: context.parentIssueId,
      allowedOperations: context.allowedOperations,
    }, target: context.target, operations: [] }
    const fake = path.join(root, "codex.mjs")
    const capturePath = path.join(root, "capture.json")
    await fs.writeFile(fake, `#!${process.execPath}
import fs from "node:fs/promises"
const args = process.argv.slice(2)
let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
const reference = await fs.readFile(${JSON.stringify(sibling)}, "utf8")
await fs.writeFile(${JSON.stringify(capturePath)}, JSON.stringify({ args, env: process.env, prompt, reference }))
await fs.writeFile(args[args.indexOf("--output-last-message") + 1], ${JSON.stringify(JSON.stringify(final))})
`)
    await fs.chmod(fake, 0o755)
    const run = {
      id: `native-${stage}`, dir: runDir, status: "running", agentResultContext: context,
      promptPath: path.join(runDir, "prompt.md"), stdoutPath: path.join(runDir, "stdout.jsonl"),
      stderrPath: path.join(runDir, "stderr.log"), finalPath: path.join(runDir, "final.txt"),
      metadataPath: path.join(runDir, "run.json"),
    }
    await fs.writeFile(run.metadataPath, JSON.stringify(run))
    const result = await runCodex({
      config: { codex: { bin: fake, executionMode: stage === "part1" ? "native" : "sandbox", defaultArgs: ["--json"] } },
      project: { path: workspace, executionMode: stage === "part1" ? "inherit" : "native" },
      stage, run, prompt: "Test only.",
      sandboxExecutable: "/nonexistent/sandbox-must-not-be-used",
      environment: {
        PATH: process.env.PATH, HOME: hostHome, TMPDIR: hostTemp,
        CODEX_HOME: path.join(hostHome, ".codex"),
        GIT_CONFIG_GLOBAL: path.join(hostHome, ".gitconfig"),
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
        SDKROOT: "/test/sdk", TOOLCHAINS: "test-toolchain",
        CLANG_MODULE_CACHE_PATH: path.join(hostHome, "clang-cache"),
        LINEAR_API_KEY: "MUST_NOT_INHERIT", UNRELATED_SECRET: "MUST_NOT_INHERIT",
        CODEX_THREAD_ID: "PARENT_THREAD", CODEX_SESSION_ID: "PARENT_SESSION",
        CODEX_APP_TOOLS_PIPE_PATH: "/parent/tools.sock",
        CODEX_PERMISSION_PROFILE: "PARENT_PERMISSION_PROFILE",
      },
      store: { appendText: (p, value) => fs.appendFile(p, value) },
    })
    assert.equal(result.status, "succeeded", JSON.stringify(result) + await fs.readFile(run.stderrPath, "utf8"))
    const capture = JSON.parse(await fs.readFile(capturePath, "utf8"))
    assert.equal(capture.env.HOME, hostHome)
    assert.equal(capture.env.TMPDIR, hostTemp)
    assert.equal(capture.env.CODEX_HOME, path.join(hostHome, ".codex"))
    assert.equal(capture.env.GIT_CONFIG_GLOBAL, path.join(hostHome, ".gitconfig"))
    assert.equal(capture.env.TOOLCHAINS, "test-toolchain")
    assert.equal(capture.env.CLANG_MODULE_CACHE_PATH, path.join(hostHome, "clang-cache"))
    assert.equal(capture.env.LINEAR_API_KEY, undefined)
    assert.equal(capture.env.UNRELATED_SECRET, undefined)
    for (const name of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_PERMISSION_PROFILE"]) {
      assert.equal(capture.env[name], undefined)
    }
    assert.equal(capture.reference, "reference-repo")
    assert.match(capture.prompt, /本机执行模式/)
    assert.match(capture.prompt, stage === "part2" ? /仅修改本任务授权/ : /不得修改业务源码/)
    for (const arg of ["mcp_servers={}", "--ignore-user-config", "--ignore-rules", "--dangerously-bypass-approvals-and-sandbox"]) {
      assert.ok(!capture.args.includes(arg), arg)
    }
    assert.ok(capture.args.includes("--approve-for-me"))
    assert.equal(capture.args[capture.args.indexOf("--add-dir") + 1], runDir)
    assert.equal(capture.args[capture.args.indexOf("--output-schema") + 1], path.join(runDir, "agent-result-schema.json"))
    assert.match(capture.prompt, /包括用户配置中可能启用的事项平台 MCP/)
    const input = JSON.parse(await fs.readFile(path.join(runDir, "supervisor-input.json"), "utf8"))
    assert.equal(input.launchBin, fake)
    assert.deepEqual(input.launchArgs, input.args)
    assert.equal(input.sandboxUserHome, null)
    assert.equal(JSON.parse(await fs.readFile(run.metadataPath, "utf8")).executionMode, "native")
    await fs.access(hostHome) // cleanup must never remove the real user HOME
  })
}
