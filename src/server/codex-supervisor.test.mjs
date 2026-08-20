import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const supervisorPath = fileURLToPath(new URL("./codex-supervisor.mjs", import.meta.url))

test("cleans review temporary files after a marked run reaches a terminal status", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-supervisor-"))
  t.after(() => fs.rm(runDir, { recursive: true, force: true }))

  const reviewDir = path.join(runDir, "review")
  const metadataPath = path.join(runDir, "run.json")
  const promptPath = path.join(runDir, "prompt.md")
  const stdoutPath = path.join(runDir, "stdout.jsonl")
  const stderrPath = path.join(runDir, "stderr.log")
  const finalPath = path.join(runDir, "final.txt")
  const inputPath = path.join(runDir, "supervisor-input.json")
  await fs.mkdir(path.join(reviewDir, "_work", "node_modules", "package"), { recursive: true })
  await fs.writeFile(path.join(reviewDir, "_work", "node_modules", "package", "index.js"), "temp")
  await fs.writeFile(path.join(reviewDir, "summary.md"), "keep")
  await fs.writeFile(promptPath, "prompt")
  await fs.writeFile(metadataPath, JSON.stringify({
    id: "run-1",
    status: "running",
    cleanupReviewTempOnCompletion: true,
  }))
  await fs.writeFile(inputPath, JSON.stringify({
    codexBin: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
    cwd: runDir,
    promptPath,
    stdoutPath,
    stderrPath,
    finalPath,
    metadataPath,
  }))

  const exitCode = await runSupervisor(inputPath)
  const run = JSON.parse(await fs.readFile(metadataPath, "utf8"))

  assert.equal(exitCode, 0)
  assert.equal(run.status, "succeeded")
  assert.deepEqual(run.reviewCleanup.removedEntries, ["_work"])
  await assert.rejects(fs.lstat(path.join(reviewDir, "_work")), { code: "ENOENT" })
  assert.equal(await fs.readFile(path.join(reviewDir, "summary.md"), "utf8"), "keep")
})

function runSupervisor(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisorPath, inputPath], { stdio: "ignore" })
    child.once("error", reject)
    child.once("close", (code) => resolve(code))
  })
}
