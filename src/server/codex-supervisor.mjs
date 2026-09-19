#!/usr/bin/env node
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import {
  agentResultRunPatch,
  evaluateAgentResult,
} from "./agent-result-runtime.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"
import { cleanupReviewTempArtifacts } from "./review-cleanup.mjs"
import { startBrowserSession } from "./browser-session.mjs"

const FORCE_KILL_DELAY_MS = 5000
const SANDBOX_HOME_PREFIX = "work-automation-codex-"

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
  let browserSession = null

  const appendStderr = async (message) => {
    await fs.mkdir(path.dirname(input.stderrPath), { recursive: true })
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

    await fs.mkdir(path.dirname(input.stdoutPath), { recursive: true })
    await fs.mkdir(path.dirname(input.stderrPath), { recursive: true })
    stdoutHandle = await fs.open(input.stdoutPath, "a")
    stderrHandle = await fs.open(input.stderrPath, "a")

    const childEnvironment = buildCodexProcessEnv(process.env, {
      blockedNames: input.blockedEnvironmentNames,
    })
    await prependMacDeveloperTools(childEnvironment)
    if (input.sandboxUserHome) {
      await fs.mkdir(input.sandboxTempDir, { recursive: true, mode: 0o700 })
      await prepareCodexRuntimeHome({
        sourceCodexHome: process.env.CODEX_HOME,
        targetCodexHome: input.innerCodexHome,
      })
      Object.assign(childEnvironment, {
        HOME: input.sandboxUserHome,
        USERPROFILE: input.sandboxUserHome,
        TMPDIR: input.sandboxTempDir,
        TMP: input.sandboxTempDir,
        TEMP: input.sandboxTempDir,
        CARGO_HOME: path.join(input.sandboxUserHome, ".cargo"),
        COREPACK_HOME: path.join(input.sandboxUserHome, ".cache", "corepack"),
        GIT_CONFIG_GLOBAL: os.devNull,
        GOPATH: path.join(input.sandboxUserHome, "go"),
        GRADLE_USER_HOME: path.join(input.sandboxUserHome, ".gradle"),
        XDG_CACHE_HOME: path.join(input.sandboxUserHome, ".cache"),
        XDG_CONFIG_HOME: path.join(input.sandboxUserHome, ".config"),
        XDG_DATA_HOME: path.join(input.sandboxUserHome, ".local", "share"),
        XDG_STATE_HOME: path.join(input.sandboxUserHome, ".local", "state"),
      })
    }
    if (input.launcherCodexHome) {
      await fs.mkdir(input.launcherCodexHome, { recursive: true })
      childEnvironment.CODEX_HOME = input.launcherCodexHome
    }
    if (input.browserEnabled) {
      browserSession = await startBrowserSession({
        runDir: path.dirname(input.metadataPath),
        cwd: input.cwd,
        runId: input.runId,
      })
      await fs.appendFile(input.promptPath, browserSession.guidance)
    }
    child = spawn(input.launchBin || input.codexBin, input.launchArgs || input.args, {
      cwd: input.cwd,
      env: childEnvironment,
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

    const processSucceeded = result.code === 0 && !result.signal && !result.error
    const startupError = childStarted
      ? null
      : result.error?.message || "Codex 子进程没有成功启动。"
    let completionPatch
    if (processSucceeded) {
      const finalText = await readOptional(input.finalPath)
      const evaluation = evaluateAgentResult(finalText, input.agentResultContext)
      completionPatch = agentResultRunPatch(evaluation)
      if (!evaluation.ok) {
        await appendStderr(`${completionPatch.error}\n`)
      }
    } else {
      completionPatch = {
        status: "failed",
        agentResult: undefined,
        agentResultValidation: undefined,
        failureKind: undefined,
        failureSummary: undefined,
        failureAction: undefined,
        retryableFailure: undefined,
        error:
          startupError ||
          (result.signal
            ? `Codex 被信号 ${result.signal} 结束。`
            : `Codex 退出码为 ${result.code}`),
      }
    }
    await updateRun({
      ...completionPatch,
      exitCode: result.code,
      codexStarted: childStarted,
      startupError,
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
    await browserSession?.close().catch(async () => {
      await appendStderr("浏览器会话清理失败。\n").catch(() => {})
    })
    await stdoutHandle?.close().catch(() => {})
    await stderrHandle?.close().catch(() => {})
    await cleanupCompletedReview().catch(async (error) => {
      await appendStderr(`Review 临时文件清理失败: ${error instanceof Error ? error.message : String(error)}\n`).catch(() => {})
    })
    await cleanupSandboxHome().catch(async (error) => {
      await appendStderr(`Codex sandbox 临时目录清理失败: ${error instanceof Error ? error.message : String(error)}\n`).catch(() => {})
    })
  }

  async function cleanupCompletedReview() {
    const run = await readJsonFile(input.metadataPath, null)
    if (
      !run?.cleanupReviewTempOnCompletion ||
      !["succeeded", "failed", "canceled"].includes(run.status)
    ) {
      return
    }
    const cleanup = await cleanupReviewTempArtifacts(path.dirname(input.metadataPath))
    await updateRun({
      reviewCleanup: {
        completedAt: new Date().toISOString(),
        removedEntries: cleanup.removedEntries,
      },
    })
  }

  async function cleanupSandboxHome() {
    const target = input.sandboxUserHome || input.launcherCodexHome
    if (!target) return
    if (!isManagedSandboxHome(target)) {
      throw new Error("拒绝清理不属于本次运行的 Codex sandbox 目录。")
    }
    await fs.rm(target, { recursive: true, force: true })
  }
}

function isManagedSandboxHome(target) {
  const resolvedTarget = path.resolve(target)
  return (
    path.dirname(resolvedTarget) === path.resolve(os.tmpdir()) &&
    path.basename(resolvedTarget).startsWith(SANDBOX_HOME_PREFIX)
  )
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
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`)
  await fs.rename(tmpPath, filePath)
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      return ""
    }
    throw error
  }
}

async function prepareCodexRuntimeHome({ sourceCodexHome, targetCodexHome }) {
  if (!targetCodexHome) return
  await fs.mkdir(targetCodexHome, { recursive: true, mode: 0o700 })
  if (!sourceCodexHome) return
  const sourceAuthPath = path.join(sourceCodexHome, "auth.json")
  const targetAuthPath = path.join(targetCodexHome, "auth.json")
  try {
    await fs.copyFile(sourceAuthPath, targetAuthPath)
    await fs.chmod(targetAuthPath, 0o600)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

async function prependMacDeveloperTools(environment) {
  if (process.platform !== "darwin") return
  const candidates = [
    environment.DEVELOPER_DIR && path.join(environment.DEVELOPER_DIR, "usr", "bin"),
    "/Applications/Xcode.app/Contents/Developer/usr/bin",
    "/Library/Developer/CommandLineTools/usr/bin",
  ].filter(Boolean)
  const readable = []
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      readable.push(candidate)
    } catch {
      // Try the next standard developer tool directory.
    }
  }
  environment.PATH = [...new Set([
    ...readable,
    ...String(environment.PATH || "").split(path.delimiter).filter(Boolean),
  ])].join(path.delimiter)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
