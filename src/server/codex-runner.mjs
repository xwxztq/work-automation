import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveExecutable } from "./executable.mjs"

const FORCE_KILL_DELAY_MS = 5000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUPERVISOR_PATH = path.join(__dirname, "codex-supervisor.mjs")

export async function runCodex({ config, project, stage, run, prompt, store, signal, onChild }) {
  await fs.writeFile(run.promptPath, prompt)

  const sandbox =
    stage === "part1"
      ? config.codex.part1Sandbox
      : stage === "split"
        ? config.codex.splitSandbox
        : stage === "part2"
        ? config.codex.part2Sandbox
        : config.codex.part3Sandbox
  const defaultArgs = normalizeCodexDefaultArgs(config.codex.defaultArgs)
  const configuredCodexBin = config.codex.bin || "codex"
  const resolvedCodexBin = await resolveExecutable(configuredCodexBin, {
    cwd: project.codexCwd || project.path,
  })
  if (!resolvedCodexBin) {
    throw new Error(
      `未找到 Codex 可执行文件: ${configuredCodexBin}。请在启动服务的进程 PATH 中加入 codex，或把 config.local.json 的 codex.bin 改成绝对路径。`,
    )
  }
  const args = [
    "exec",
    ...defaultArgs,
    "--sandbox",
    sandbox,
    "-C",
    project.codexCwd || project.path,
    "--output-last-message",
    run.finalPath,
    "-",
  ]
  const supervisorInputPath = path.join(run.dir, "supervisor-input.json")
  await fs.writeFile(
    supervisorInputPath,
    `${JSON.stringify(
      {
        codexBin: resolvedCodexBin,
        args,
        cwd: project.codexCwd || project.path,
        promptPath: run.promptPath,
        stdoutPath: run.stdoutPath,
        stderrPath: run.stderrPath,
        finalPath: run.finalPath,
        metadataPath: run.metadataPath,
      },
      null,
      2,
    )}\n`,
  )

  const supervisor = spawn(process.execPath, [SUPERVISOR_PATH, supervisorInputPath], {
    cwd: project.codexCwd || project.path,
    env: process.env,
    detached: true,
    stdio: "ignore",
  })
  const started = Number.isInteger(supervisor.pid) && supervisor.pid > 0
  const supervisorPid = started ? supervisor.pid : null
  let canceled = false
  let forceKillTimer = null
  let supervisorError = null

  const appendRunError = (message) => {
    void store.appendText(run.stderrPath, message).catch(() => {})
  }

  const cancelSupervisor = (reason = "用户中止任务") => {
    canceled = true
    appendRunError(`${reason}\n`)
    if (!started || supervisor.exitCode != null || supervisor.killed) {
      return
    }
    supervisor.kill("SIGTERM")
    forceKillTimer = setTimeout(() => {
      if (supervisor.exitCode == null) {
        appendRunError("Codex supervisor 未及时退出，已强制停止。\n")
        supervisor.kill("SIGKILL")
      }
    }, FORCE_KILL_DELAY_MS)
  }

  if (signal?.aborted) {
    cancelSupervisor(abortReason(signal, "用户中止任务"))
  } else {
    signal?.addEventListener(
      "abort",
      () => cancelSupervisor(abortReason(signal, "用户中止任务")),
      { once: true },
    )
  }

  onChild?.({
    pid: supervisorPid,
    supervisorPid,
  })

  const supervisorExitCode = await new Promise((resolve) => {
    supervisor.on("error", async (error) => {
      supervisorError = error
      await store.appendText(run.stderrPath, `${error.stack || error.message}\n`)
      resolve(1)
    })
    supervisor.on("close", (code) => resolve(code ?? 0))
  })

  if (forceKillTimer) {
    clearTimeout(forceKillTimer)
  }

  const latestRun = await readJsonFile(run.metadataPath, run)
  const finalText = await readOptional(run.finalPath)
  const codexStarted = Boolean(latestRun.codexStarted)

  return {
    exitCode: latestRun.exitCode ?? supervisorExitCode,
    finalText,
    canceled: canceled || latestRun.status === "canceled",
    started: codexStarted,
    startError: !started
      ? supervisorError?.message || "Codex supervisor 没有成功启动。"
      : latestRun.startupError || null,
    supervisorPid: latestRun.supervisorPid || supervisorPid,
    codexPid: latestRun.codexPid || null,
  }
}

function normalizeCodexDefaultArgs(defaultArgs = []) {
  const normalized = Array.isArray(defaultArgs)
    ? defaultArgs.map((value) => String(value).trim()).filter(Boolean)
    : []
  if (normalized.includes("--skip-git-repo-check")) {
    return normalized
  }
  return [...normalized, "--skip-git-repo-check"]
}

function abortReason(signal, fallback) {
  if (!signal?.reason) {
    return fallback
  }
  return typeof signal.reason === "string" ? signal.reason : fallback
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
