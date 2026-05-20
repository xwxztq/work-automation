import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const FORCE_KILL_DELAY_MS = 5000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUPERVISOR_PATH = path.join(__dirname, "codex-supervisor.mjs")

export async function runCodex({ config, project, stage, run, prompt, store, signal, onChild }) {
  await fs.writeFile(run.promptPath, prompt)

  const sandbox = stage === "part1" ? config.codex.part1Sandbox : config.codex.part2Sandbox
  const args = [
    "exec",
    ...config.codex.defaultArgs,
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
        codexBin: config.codex.bin || "codex",
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
