#!/usr/bin/env node
import fs from "node:fs/promises"
import { spawn } from "node:child_process"

const inputPath = process.argv[2]
if (!inputPath) {
  throw new Error("Missing supervisor input path.")
}

const input = JSON.parse(await fs.readFile(inputPath, "utf8"))
const environment = { ...process.env, CODEX_HOME: input.innerCodexHome }
let child = null

const forwardSignal = (signal) => {
  if (child && child.exitCode == null && !child.killed) {
    child.kill(signal)
  }
}

process.once("SIGINT", () => forwardSignal("SIGINT"))
process.once("SIGTERM", () => forwardSignal("SIGTERM"))

child = spawn(input.codexBin, input.args, {
  cwd: input.cwd,
  env: environment,
  stdio: "inherit",
})

const result = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, signal: null, error }))
  child.once("close", (code, signal) =>
    resolve({ code: code ?? 0, signal, error: null }),
  )
})

if (result.error) {
  console.error(result.error.stack || result.error.message)
  process.exit(1)
}
if (result.signal) {
  process.kill(process.pid, result.signal)
} else {
  process.exit(result.code)
}
