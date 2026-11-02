import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { readJsonFile, writeJsonFile } from "./config.mjs"

export const ISSUE_PROGRESS_CLIENT_PATH = fileURLToPath(new URL("./issue-progress-client.mjs", import.meta.url))
const REQUEST_NAME = /^[0-9a-f-]{36}\.json$/u
const COMPLETE = { status: "completed", safeTerminal: true, operations: [] }

export async function initializeIssueProgress(run, config) {
  if (run.stage !== "superpower") return
  const dir = path.join(run.dir, "progress")
  await fs.mkdir(path.join(dir, "requests"), { recursive: true })
  await fs.mkdir(path.join(dir, "responses"), { recursive: true })
  await writeJsonFile(path.join(dir, "state.json"), {
    runId: run.id,
    stateId: run.issueBinding.stateId,
    stateName: run.issueBinding.stateName,
    statuses: { inProgress: config.statuses.inProgress, testing: config.statuses.testing },
    sealedRequests: null,
  })
}

export function issueProgressGuidance(run) {
  if (run.stage !== "superpower") return ""
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
  return `\n运行中同步事项状态：开始分析或实现、检验后继续修改时调用 ${quote(process.execPath)} ${quote(ISSUE_PROGRESS_CLIENT_PATH)} ${quote(run.dir)} inProgress；进入检验时将末尾参数改为 testing。由主会话按顺序调用并等待回执；失败时说明原因，不声称已更新。此命令由服务写回，不需要平台凭据。\n`
}

// The agent can write requests only. The service owns acknowledgements and the
// last verified state, separately from run.json which the supervisor also writes.
export function createIssueProgressSession({ run, store, execute, signal, pollMs = 250 }) {
  const dir = path.join(run.dir, "progress")
  const statePath = path.join(dir, "state.json")
  let timer = null
  let stopped = false
  let queue = Promise.resolve()

  function serialize(action) {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }

  async function loadState() {
    const state = await readJsonFile(statePath, null)
    if (state && state.runId !== run.id) throw new Error("运行进度绑定不一致。")
    return state
  }

  async function requestNames() {
    return (await fs.readdir(path.join(dir, "requests"))).filter((name) => REQUEST_NAME.test(name)).sort()
  }

  async function processRequests({ finishing = false } = {}) {
    const state = await loadState()
    if (!state) { stop(); return COMPLETE } // Older runs have no progress channel.
    if (state.failure) return state.failure
    const latest = await store.getRunMetadata(run.id)
    if (!latest) { stop(); return failure("CONFLICT") }
    if (signal?.aborted || latest?.status === "canceled") { stop(); return failure("CANCELED") }
    if (!finishing && (latest?.status !== "running" ||
      latest.operationExecution?.status !== "waiting-for-agent-result" || state.sealedRequests)) {
      stop()
      return COMPLETE
    }
    const names = state.sealedRequests || await requestNames()
    if (names.length > 64) return failure("INVALID_REQUEST")
    for (const name of names) {
      const responsePath = path.join(dir, "responses", name)
      if (await readJsonFile(responsePath, null)) continue
      let request
      try {
        request = await readRequest(path.join(dir, "requests", name))
      } catch {
        await writeJsonFile(responsePath, { ok: false, error: "进度请求不合法。" })
        continue
      }
      if (signal?.aborted) return failure("CANCELED")
      const idempotencyKey = `progress:${createHash("sha256").update(run.id).digest("hex").slice(0, 24)}:${name.slice(0, -5)}`
      const context = run.agentResultContext
      const boundRun = { ...run, issueBinding: { ...run.issueBinding, stateId: state.stateId, stateName: state.stateName } }
      const result = await execute({
        run: boundRun,
        purpose: "progress",
        agentResult: {
          schemaVersion: context.schemaVersion,
          run: { stage: context.stage, projectKey: context.projectKey, parentIssueId: context.parentIssueId, allowedOperations: context.allowedOperations },
          target: context.target,
          operations: [{ type: "issue.state.update", idempotencyKey, payload: { state: state.statuses[request.state] } }],
        },
      })
      if (result.status === "retryable") return result
      if (result.status !== "completed") {
        state.failure = result
        await writeJsonFile(statePath, state)
        await writeJsonFile(responsePath, { ok: false, error: result.error?.message || "状态更新被拒绝。" })
        return result
      }
      const record = await store.getIssueOperation({ platform: context.target.platform, projectKey: run.projectKey,
        issueId: run.issueId, type: "issue.state.update", idempotencyKey })
      if (record?.status !== "verified" || !record.intent?.state?.id) return failure("CONFLICT")
      state.stateId = record.intent.state.id
      state.stateName = record.intent.state.name
      await writeJsonFile(statePath, state)
      await writeJsonFile(responsePath, { ok: true, state: state.stateName })
      await store.appendEvent({ type: "issue-progress", runId: run.id, projectKey: run.projectKey, stage: run.stage,
        issueIdentifier: run.issueIdentifier, message: `${run.issueIdentifier} 状态已更新为 ${state.stateName}` })
    }
    return COMPLETE
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
  }

  function start() {
    if (timer || stopped) return
    const tick = async () => {
      let result
      try {
        result = await serialize(() => processRequests())
      } catch {
        result = { status: "retryable" }
      }
      if (!stopped) {
        timer = setTimeout(tick, result.status === "retryable" ? 2000 : pollMs)
        timer.unref?.()
      }
    }
    timer = setTimeout(tick, pollMs)
    timer.unref?.()
  }

  async function finish() {
    stop()
    return serialize(async () => {
      const state = await loadState()
      if (!state) return COMPLETE
      if (!state.sealedRequests) {
        state.sealedRequests = await requestNames()
        await writeJsonFile(statePath, state)
      }
      return processRequests({ finishing: true })
    })
  }

  async function boundRun() {
    const state = await loadState()
    return state ? { ...run, issueBinding: { ...run.issueBinding, stateId: state.stateId, stateName: state.stateName } } : run
  }

  return { start, stop, finish, boundRun }
}

async function readRequest(filePath) {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) throw new Error("Invalid request file")
    const bytes = Buffer.alloc(1025)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 1024) throw new Error("Request too large")
    const request = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))
    if (!request || Object.keys(request).length !== 1 || !["inProgress", "testing"].includes(request.state)) throw new Error("Invalid state")
    return request
  } finally {
    await handle.close()
  }
}

function failure(code) {
  return { status: "manual-required", safeTerminal: true, operations: [], error: {
    code, message: "事项进度更新未完成。", operation: "issue.state.update", retryable: false,
  } }
}
