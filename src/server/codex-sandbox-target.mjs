#!/usr/bin/env node
import fs from "node:fs/promises"
import { spawn } from "node:child_process"

const inputPath = process.argv[2]
if (!inputPath) {
  throw new Error("Missing supervisor input path.")
}

const input = JSON.parse(await fs.readFile(inputPath, "utf8"))
const environment = { ...process.env, CODEX_HOME: input.innerCodexHome }
if (input.nodeOptions) environment.NODE_OPTIONS = input.nodeOptions
let child = null
let interrupted = null

const forwardSignal = (signal) => {
  interrupted = signal
  if (child && child.exitCode == null && !child.killed) {
    child.kill(signal)
  }
}

process.once("SIGINT", () => forwardSignal("SIGINT"))
process.once("SIGTERM", () => forwardSignal("SIGTERM"))

let checkout = null
let refusalCode = 1
if (input.gitCheckout) {
  try {
    const { checkoutGitBranch, GIT_CHECKOUT_REFUSED } = await import("./git-branch.mjs")
    refusalCode = GIT_CHECKOUT_REFUSED
    if (!interrupted) checkout = await checkoutGitBranch(input.gitCheckout, environment)
  } catch (error) {
    console.error(`WA Git: ${error.stderr?.trim() || error.message}`)
    process.exit(refusalCode)
  }
}

if (interrupted) {
  await restoreCheckout()
  process.exit(1)
}

child = spawn(input.codexBin, input.args, {
  cwd: input.cwd,
  env: environment,
  windowsHide: true,
  stdio: "inherit",
})

const result = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, signal: null, error }))
  child.once("close", (code, signal) =>
    resolve({ code: code ?? 0, signal, error: null }),
  )
})

const onExpectedBranch = !checkout || await checkout.isOnBranch().catch(() => false)
await restoreCheckout()
if (!onExpectedBranch && result.code === 0 && !result.signal) {
  console.error("WA Git: Codex 结束时当前分支和本轮分配的工作分支不一致。")
  process.exit(1)
}

if (result.error) {
  console.error(result.error.stack || result.error.message)
  process.exit(1)
}
if (result.signal) {
  process.kill(process.pid, result.signal)
} else {
  process.exit(result.code)
}

async function restoreCheckout() {
  if (!checkout) return
  try {
    if (!await checkout.restore()) console.error("WA Git: 当前分支或工作树已变化，保留现场。")
  } catch (error) {
    console.error(`WA Git: 无法恢复开始前的分支：${error.stderr?.trim() || error.message}`)
  }
}
