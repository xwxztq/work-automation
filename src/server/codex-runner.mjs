import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { extractJson } from "./prompts.mjs"

export async function runCodex({ config, project, stage, run, prompt, store }) {
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

  const appendRunError = (message) => {
    void store.appendText(run.stderrPath, message).catch(() => {})
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

  child.stdin.end(prompt)

  const exitCode = await new Promise((resolve) => {
    child.on("error", async (error) => {
      await store.appendText(run.stderrPath, `${error.stack || error.message}\n`)
      resolve(1)
    })
    child.on("close", (code) => resolve(code ?? 0))
  })

  let finalText = ""
  try {
    finalText = await fs.readFile(run.finalPath, "utf8")
  } catch {
    finalText = ""
  }

  return {
    exitCode,
    finalText,
    finalJson: extractJson(finalText),
  }
}
