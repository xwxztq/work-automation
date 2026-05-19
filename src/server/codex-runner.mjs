import fs from "node:fs/promises"
import { spawn } from "node:child_process"

const FORCE_KILL_DELAY_MS = 5000

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

  const child = spawn(config.codex.bin || "codex", args, {
    cwd: project.codexCwd || project.path,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let canceled = false
  let forceKillTimer = null

  const appendRunError = (message) => {
    void store.appendText(run.stderrPath, message).catch(() => {})
  }

  const cancelChild = (reason = "用户中止任务") => {
    canceled = true
    appendRunError(`${reason}\n`)
    if (child.exitCode != null || child.killed) {
      return
    }
    child.kill("SIGTERM")
    forceKillTimer = setTimeout(() => {
      if (child.exitCode == null) {
        appendRunError("Codex 子进程未及时退出，已强制停止。\n")
        child.kill("SIGKILL")
      }
    }, FORCE_KILL_DELAY_MS)
  }

  if (signal?.aborted) {
    cancelChild(abortReason(signal, "用户中止任务"))
  } else {
    signal?.addEventListener("abort", () => cancelChild(abortReason(signal, "用户中止任务")), {
      once: true,
    })
  }

  child.stdout.on("data", (chunk) => {
    void store.appendText(run.stdoutPath, chunk.toString())
  })
  child.stdout.on("error", (error) => {
    appendRunError(`${error.stack || error.message}\n`)
  })

  child.stderr.on("data", (chunk) => {
    void store.appendText(run.stderrPath, chunk.toString())
  })
  child.stderr.on("error", (error) => {
    appendRunError(`${error.stack || error.message}\n`)
  })

  child.stdin.on("error", (error) => {
    const detail =
      error.code === "EPIPE"
        ? "Codex 子进程在读取提示词前关闭了 stdin。请查看同一运行日志中的 stderr 判断 Codex 退出原因。"
        : error.stack || error.message
    appendRunError(`${detail}\n`)
  })

  onChild?.(child)
  if (!canceled) {
    child.stdin.end(prompt)
  }

  const exitCode = await new Promise((resolve) => {
    child.on("error", async (error) => {
      await store.appendText(run.stderrPath, `${error.stack || error.message}\n`)
      resolve(1)
    })
    child.on("close", (code) => resolve(code ?? 0))
  })

  if (forceKillTimer) {
    clearTimeout(forceKillTimer)
  }

  let finalText = ""
  try {
    finalText = await fs.readFile(run.finalPath, "utf8")
  } catch {
    finalText = ""
  }

  return {
    exitCode,
    finalText,
    canceled,
  }
}

function abortReason(signal, fallback) {
  if (!signal?.reason) {
    return fallback
  }
  return typeof signal.reason === "string" ? signal.reason : fallback
}
