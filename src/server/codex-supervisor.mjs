#!/usr/bin/env node
import fs from "node:fs/promises"
import { spawn } from "node:child_process"

const FORCE_KILL_DELAY_MS = 5000

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Missing supervisor input path.")
  }

  const input = JSON.parse(await fs.readFile(inputPath, "utf8"))
  const startedAt = new Date().toISOString()
  let child = null
  let childStarted = false
  let cancelReason = null
  let forceKillTimer = null
  let stdoutHandle = null
  let stderrHandle = null

  const appendStderr = async (message) => {
    await fs.mkdir(dirname(input.stderrPath), { recursive: true })
    await fs.appendFile(input.stderrPath, message)
  }

  const updateRun = async (patch) => {
    const current = await readJsonFile(input.metadataPath, {})
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await writeJsonFile(input.metadataPath, next)
    return next
  }

  const requestCancel = (reason) => {
    cancelReason = reason
    if (!childStarted || !child || child.exitCode != null || child.killed) {
      return
    }
    child.kill("SIGTERM")
    forceKillTimer = setTimeout(() => {
      if (child && child.exitCode == null) {
        void appendStderr("Codex 子进程未及时退出，已强制停止。\n").catch(() => {})
        child.kill("SIGKILL")
      }
    }, FORCE_KILL_DELAY_MS)
  }

  process.once("SIGINT", () => requestCancel("用户中止任务"))
  process.once("SIGTERM", () => requestCancel("用户中止任务"))

  try {
    await updateRun({
      status: "running",
      pid: process.pid,
      supervisorPid: process.pid,
      supervisorStartedAt: startedAt,
    })

    await fs.mkdir(dirname(input.stdoutPath), { recursive: true })
    await fs.mkdir(dirname(input.stderrPath), { recursive: true })
    stdoutHandle = await fs.open(input.stdoutPath, "a")
    stderrHandle = await fs.open(input.stderrPath, "a")

    child = spawn(input.codexBin, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", stdoutHandle.fd, stderrHandle.fd],
    })

    const codexPid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null
    childStarted = Boolean(codexPid)
    child.stdin.on("error", (error) => {
      const detail =
        error.code === "EPIPE"
          ? "Codex 子进程在读取提示词前关闭了 stdin。请查看同一运行日志中的 stderr 判断 Codex 退出原因。"
          : error.stack || error.message
      void appendStderr(`${detail}\n`).catch(() => {})
    })
    await updateRun({
      codexStarted: childStarted,
      codexPid,
      startupError: childStarted ? null : "Codex 子进程没有成功启动。",
    })

    if (childStarted) {
      child.stdin.end(await fs.readFile(input.promptPath))
    }

    const result = await new Promise((resolve) => {
      child.once("error", (error) => {
        resolve({ code: 1, signal: null, error })
      })
      child.once("close", (code, signal) => {
        resolve({ code: code ?? 0, signal, error: null })
      })
    })

    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }

    if (cancelReason) {
      await updateRun({
        status: "canceled",
        exitCode: result.code,
        canceledAt: new Date().toISOString(),
        cancelReason,
        error: undefined,
      })
      return
    }

    if (result.error) {
      await appendStderr(`${result.error.stack || result.error.message}\n`)
    }

    const succeeded = result.code === 0 && !result.signal && !result.error
    const startupError = childStarted
      ? null
      : result.error?.message || "Codex 子进程没有成功启动。"
    await updateRun({
      status: succeeded ? "succeeded" : "failed",
      exitCode: result.code,
      codexStarted: childStarted,
      startupError,
      error: succeeded
        ? undefined
        : startupError || (result.signal ? `Codex 被信号 ${result.signal} 结束。` : `Codex 退出码为 ${result.code}`),
    })
  } catch (error) {
    await appendStderr(`${error.stack || error.message}\n`).catch(() => {})
    await updateRun({
      status: cancelReason ? "canceled" : "failed",
      canceledAt: cancelReason ? new Date().toISOString() : undefined,
      cancelReason: cancelReason || undefined,
      codexStarted: childStarted,
      startupError: childStarted ? null : error.message,
      error: cancelReason ? undefined : error.message,
    }).catch(() => {})
  } finally {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
    }
    await stdoutHandle?.close().catch(() => {})
    await stderrHandle?.close().catch(() => {})
  }
}

function dirname(filePath) {
  const index = filePath.lastIndexOf("/")
  return index === -1 ? "." : filePath.slice(0, index)
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback
    }
    throw error
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`)
  await fs.rename(tmpPath, filePath)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
