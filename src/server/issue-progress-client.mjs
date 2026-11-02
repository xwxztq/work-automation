#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

export async function requestIssueProgress(runDir, state, { timeoutMs = 120000, pollMs = 250 } = {}) {
  if (!["inProgress", "testing"].includes(state)) throw new Error("状态只支持 inProgress 或 testing。")
  const dir = path.join(runDir, "progress")
  const journal = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"))
  if (journal.sealedRequests) throw new Error("本次运行已停止接收进度更新。")
  const name = `${randomUUID()}.json`
  const requestPath = path.join(dir, "requests", name)
  await fs.writeFile(`${requestPath}.tmp`, JSON.stringify({ state }), { flag: "wx", mode: 0o600 })
  await fs.rename(`${requestPath}.tmp`, requestPath)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await fs.readFile(path.join(dir, "responses", name), "utf8"))
      if (!response.ok) throw new Error(response.error)
      return response
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const run = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8"))
    if (run.status !== "running") throw new Error("运行已结束，状态更新尚未确认。")
    await delay(pollMs)
  }
  throw new Error("等待状态更新超时；请求已保留，不能视为更新成功。")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [runDir, state] = process.argv.slice(2)
    if (!runDir) throw new Error("Usage: issue-progress-client.mjs <run-dir> <inProgress|testing>")
    console.log(JSON.stringify(await requestIssueProgress(runDir, state)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
