import fs from "node:fs/promises"
import path from "node:path"

const RECENT_EVENT_IDLE_MS = 12_000
const DETAIL_LIMIT = 96
const ACTIVITY_STDOUT_READ_LIMIT_BYTES = 256 * 1024
const ACTIVITY_CACHE_LIMIT = 128
const MAX_PENDING_LINE_BYTES = 256 * 1024

export async function createCodexActivityPayload({ scheduler, store, projectKey, activityReader }) {
  const status = await scheduler.status()
  const activeRuns = status.activeRuns.filter((run) => !projectKey || run.projectKey === projectKey)
  const reader = activityReader || createCodexActivityReader()
  const agents = await Promise.all(activeRuns.map(async (activeRun) => {
    const persisted = await readActivityRun(store, activeRun.runId)
    const run = persisted || fallbackRunFromActive(activeRun)
    return reader.summarize(run, { activeRun })
  }))
  reader.retain(status.activeRuns.map((run) => run.runId))

  return {
    generatedAt: new Date().toISOString(),
    agents: agents.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))),
  }
}

export function summarizeCodexRun(run, fsInfo = {}) {
  const activityState = createActivityState()
  for (const event of parseJsonl(String(run.stdout || ""))) {
    applyActivityEvent(activityState, event)
  }
  return summarizeCodexRunFromState(run, activityState, {
    ...fsInfo,
    stdoutObserved: Boolean(run.stdout),
  })
}

export function createCodexActivityReader({
  fileSystem = fs,
  readLimitBytes = ACTIVITY_STDOUT_READ_LIMIT_BYTES,
  cacheLimit = ACTIVITY_CACHE_LIMIT,
} = {}) {
  const entries = new Map()
  const readsInFlight = new Map()

  async function summarize(run, fsInfo = {}) {
    if (run.status !== "running" || !run.stdoutPath) {
      return summarizeCodexRun(run, fsInfo)
    }
    const entry = await updateRunActivity(run)
    return summarizeCodexRunFromState(run, entry?.activityState || createActivityState(), {
      ...fsInfo,
      stdoutMtimeMs: entry?.mtimeMs ?? null,
      stdoutObserved: Boolean(entry?.stdoutObserved),
    })
  }

  async function updateRunActivity(run) {
    const runId = String(run.id || "")
    if (!runId || !run.stdoutPath) {
      return null
    }
    const existingRead = readsInFlight.get(runId)
    if (existingRead) {
      return existingRead
    }

    const request = readRunActivity(runId, run.stdoutPath).finally(() => {
      if (readsInFlight.get(runId) === request) {
        readsInFlight.delete(runId)
      }
    })
    readsInFlight.set(runId, request)
    return request
  }

  async function readRunActivity(runId, stdoutPath) {
    let handle
    try {
      handle = await fileSystem.open(stdoutPath, "r")
    } catch (error) {
      if (error?.code === "ENOENT") {
        entries.delete(runId)
        return null
      }
      throw error
    }

    try {
      const stat = await handle.stat()
      let entry = entries.get(runId)
      const shouldReset =
        !entry ||
        entry.stdoutPath !== stdoutPath ||
        entry.dev !== stat.dev ||
        entry.ino !== stat.ino ||
        stat.size < entry.offset ||
        (stat.size === entry.offset && stat.mtimeMs !== entry.mtimeMs)

      if (shouldReset || stat.size - (entry?.offset || 0) > readLimitBytes) {
        entry = createReaderEntry(runId, stdoutPath, stat, entry)
        const start = Math.max(0, stat.size - readLimitBytes)
        const chunk = await readFileRange(handle, start, stat.size - start)
        entry.offset = start + chunk.length
        entry.lastBytesRead = chunk.length
        entry.totalBytesRead += chunk.length
        consumeInitialChunk(entry, chunk, start)
      } else if (stat.size > entry.offset) {
        const start = entry.offset
        const chunk = await readFileRange(handle, start, stat.size - start)
        entry.offset = start + chunk.length
        entry.lastBytesRead = chunk.length
        entry.totalBytesRead += chunk.length
        consumeActivityChunk(entry, chunk, start)
      } else {
        entry.lastBytesRead = 0
        entry.lastParsedBytes = 0
      }

      entry.dev = stat.dev
      entry.ino = stat.ino
      entry.mtimeMs = stat.mtimeMs
      entry.stdoutObserved = entry.offset > 0
      entry.lastAccessedAt = Date.now()
      entries.delete(runId)
      entries.set(runId, entry)
      trimEntries()
      return entry
    } finally {
      await handle.close()
    }
  }

  function retain(runIds) {
    const retained = new Set(runIds.map(String))
    for (const runId of entries.keys()) {
      if (!retained.has(runId)) {
        entries.delete(runId)
      }
    }
    trimEntries()
  }

  function inspect(runId) {
    const entry = entries.get(String(runId))
    if (!entry) {
      return null
    }
    return {
      offset: entry.offset,
      parsedOffset: entry.parsedOffset,
      pendingBytes: entry.pending.length,
      lastBytesRead: entry.lastBytesRead,
      totalBytesRead: entry.totalBytesRead,
      lastParsedBytes: entry.lastParsedBytes,
      resetCount: entry.resetCount,
      stdoutObserved: entry.stdoutObserved,
    }
  }

  function trimEntries() {
    while (entries.size > cacheLimit) {
      entries.delete(entries.keys().next().value)
    }
  }

  return {
    summarize,
    retain,
    inspect,
  }
}

function summarizeCodexRunFromState(run, activityState, fsInfo = {}) {
  const base = {
    runId: String(run.id || fsInfo.activeRun?.runId || ""),
    projectKey: String(run.projectKey || fsInfo.activeRun?.projectKey || ""),
    stage: String(run.stage || fsInfo.activeRun?.stage || ""),
    issueIdentifier: String(run.issueIdentifier || fsInfo.activeRun?.issue?.identifier || ""),
    issueTitle: String(run.issueTitle || fsInfo.activeRun?.issue?.title || ""),
    startedAt: String(run.createdAt || fsInfo.activeRun?.startedAt || run.updatedAt || new Date().toISOString()),
    status: run.status || "running",
    updatedAt: newestIso(run.updatedAt, fsInfo.stdoutMtimeMs),
    pid: run.pid ?? fsInfo.activeRun?.pid ?? null,
    supervisorPid: run.supervisorPid ?? fsInfo.activeRun?.supervisorPid ?? null,
    codexPid: run.codexPid ?? fsInfo.activeRun?.codexPid ?? null,
  }

  if (base.status === "succeeded") {
    return withActivity(base, "done", "完成", detailFromFinal(run), {
      motion: "success",
      tool: "other",
    })
  }
  if (base.status === "failed") {
    return withActivity(base, "failed", "失败", cleanDetail(run.error || run.startupError || "Codex 运行失败"), {
      motion: "failure",
      tool: "other",
    })
  }
  if (base.status === "canceled") {
    return withActivity(base, "canceled", "已中止", cleanDetail(run.cancelReason || "任务已停止"), {
      motion: "failure",
      tool: "other",
    })
  }
  if (run.codexStarted === false || (!base.codexPid && !fsInfo.stdoutObserved)) {
    return withActivity(base, "booting", "启动中", cleanDetail(run.startupError || "等待 Codex 子进程"), {
      motion: "waiting",
      tool: "other",
    })
  }

  const activity = inferActivityFromState(activityState, base.updatedAt)
  return withActivity(base, activity.kind, activity.label, activity.detail, {
    motion: activity.motion,
    tool: activity.tool,
  })
}

function createActivityState() {
  return {
    activeItems: new Map(),
    latestActivity: null,
    latestError: null,
    latestMessage: null,
    eventSequence: 0,
  }
}

function applyActivityEvent(state, event) {
  state.eventSequence += 1
  if (event.type === "error") {
    state.latestError = event
    state.latestActivity = {
      kind: "waiting",
      label: "等待恢复",
      detail: cleanDetail(event.message || "Codex 连接暂时不可用"),
      motion: "waiting",
      tool: "other",
    }
    return
  }

  const item = event.item
  if (!item || typeof item !== "object") {
    if (event.type === "turn.started") {
      state.latestActivity = {
        kind: "thinking",
        label: "思考中",
        detail: "新回合已开始",
        motion: "reading",
        tool: "other",
      }
    }
    return
  }

  const id = item.id || `${event.type}:${state.eventSequence}`
  const itemActivity = activityFromItem(item)
  if (!itemActivity) {
    return
  }

  if (item.type === "agent_message") {
    state.latestMessage = item
  }

  if (event.type === "item.started") {
    state.activeItems.set(id, itemActivity)
    state.latestActivity = itemActivity
    return
  }

  if (event.type === "item.completed") {
    state.activeItems.delete(id)
    state.latestActivity = itemActivity
    return
  }

  if (event.type === "item.updated") {
    if (item.status === "in_progress" || item.status === "running") {
      state.activeItems.set(id, itemActivity)
    } else if (item.status === "completed" || item.status === "failed") {
      state.activeItems.delete(id)
    }
    state.latestActivity = itemActivity
  }
}

function inferActivityFromState(state, updatedAt) {
  const active = [...state.activeItems.values()].at(-1)
  if (active) {
    return active
  }

  if (state.latestActivity && isRecent(updatedAt)) {
    return state.latestActivity
  }

  if (state.latestError && isRecent(updatedAt, RECENT_EVENT_IDLE_MS * 3)) {
    return {
      kind: "waiting",
      label: "等待恢复",
      detail: cleanDetail(state.latestError.message || "Codex 连接暂时不可用"),
      motion: "waiting",
      tool: "other",
    }
  }

  if (state.latestMessage) {
    return {
      kind: "thinking",
      label: "整理输出",
      detail: cleanDetail(state.latestMessage.text || "Codex 正在汇总结果"),
      motion: "reading",
      tool: "other",
    }
  }

  return {
    kind: "waiting",
    label: "等待输出",
    detail: "暂未检测到新的 Codex 事件",
    motion: "waiting",
    tool: "other",
  }
}

function activityFromItem(item) {
  if (item.type === "command_execution") {
    const command = summarizeCommand(item.command)
    const classification = classifyCommand(command)
    return {
      kind: "command",
      label: "跑命令",
      detail: command,
      motion: classification.motion,
      tool: classification.tool,
    }
  }
  if (item.type === "mcp_tool_call") {
    const classification = classifyMcpTool(item.server, item.tool)
    return {
      kind: "tool",
      label: "工具调用",
      detail: [item.server, item.tool].filter(Boolean).join(".") || "调用外部工具",
      motion: classification.motion,
      tool: classification.tool,
    }
  }
  if (item.type === "file_change") {
    return {
      kind: "writing",
      label: "改文件",
      detail: summarizeFileChanges(item.changes),
      motion: "typing",
      tool: "edit",
    }
  }
  if (item.type === "todo_list") {
    return {
      kind: "todo",
      label: "更新清单",
      detail: summarizeTodos(item.items),
      motion: "typing",
      tool: "todo",
    }
  }
  if (item.type === "web_search") {
    return {
      kind: "searching",
      label: "搜索",
      detail: cleanDetail(item.query || item.text || "正在搜索资料"),
      motion: "reading",
      tool: "search",
    }
  }
  if (item.type === "agent_message") {
    return {
      kind: "thinking",
      label: "思考中",
      detail: cleanDetail(item.text || "Codex 正在输出进展"),
      motion: "reading",
      tool: "other",
    }
  }
  return null
}

function parseJsonl(text) {
  const events = []
  const lines = text.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // stdout may be read while Codex is writing a partial JSONL line.
    }
  }
  return events
}

function createReaderEntry(runId, stdoutPath, stat, previous) {
  return {
    runId,
    stdoutPath,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    offset: 0,
    parsedOffset: 0,
    pending: Buffer.alloc(0),
    skipUntilNewline: false,
    activityState: createActivityState(),
    stdoutObserved: false,
    lastBytesRead: 0,
    totalBytesRead: previous?.totalBytesRead || 0,
    lastParsedBytes: 0,
    resetCount: previous ? previous.resetCount + 1 : 0,
    lastAccessedAt: Date.now(),
  }
}

async function readFileRange(handle, position, length) {
  if (length <= 0) {
    return Buffer.alloc(0)
  }
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

function consumeInitialChunk(entry, chunk, start) {
  entry.lastParsedBytes = 0
  if (start === 0) {
    consumeActivityChunk(entry, chunk, start)
    return
  }

  const firstNewline = chunk.indexOf(0x0a)
  if (firstNewline < 0) {
    entry.pending = Buffer.alloc(0)
    entry.parsedOffset = entry.offset
    entry.skipUntilNewline = true
    return
  }

  const dataStart = start + firstNewline + 1
  consumeActivityChunk(entry, chunk.subarray(firstNewline + 1), dataStart)
}

function consumeActivityChunk(entry, chunk, start) {
  entry.lastParsedBytes = 0
  let data = chunk
  let dataStart = start

  if (entry.skipUntilNewline) {
    const firstNewline = data.indexOf(0x0a)
    if (firstNewline < 0) {
      entry.parsedOffset = start + data.length
      return
    }
    dataStart += firstNewline + 1
    data = data.subarray(firstNewline + 1)
    entry.skipUntilNewline = false
  }

  const combined = entry.pending.length > 0
    ? Buffer.concat([entry.pending, data])
    : data
  const combinedStart = dataStart - entry.pending.length
  let lineStart = 0

  for (let index = 0; index < combined.length; index += 1) {
    if (combined[index] !== 0x0a) {
      continue
    }
    const line = combined.subarray(lineStart, index)
    entry.lastParsedBytes += index - lineStart + 1
    applyJsonlLine(entry.activityState, line)
    lineStart = index + 1
  }

  entry.pending = Buffer.from(combined.subarray(lineStart))
  entry.parsedOffset = combinedStart + lineStart
  if (entry.pending.length > MAX_PENDING_LINE_BYTES) {
    entry.pending = Buffer.alloc(0)
    entry.parsedOffset = entry.offset
    entry.skipUntilNewline = true
  }
}

function applyJsonlLine(activityState, line) {
  const trimmed = line.toString("utf8").trim()
  if (!trimmed) {
    return
  }
  try {
    applyActivityEvent(activityState, JSON.parse(trimmed))
  } catch {
    // A complete malformed line is ignored; subsequent JSONL events remain readable.
  }
}

function summarizeCommand(command) {
  const text = String(command || "").trim()
  const shellMatch = text.match(/^\/bin\/zsh -lc ['"]([\s\S]*)['"]$/)
  return cleanDetail(shellMatch?.[1] || text || "执行命令")
}

function classifyCommand(command) {
  const text = String(command || "").trim()
  const normalized = text
    .replace(/^['"]|['"]$/g, "")
    .replace(/^(?:pnpm|npm|node|git|rg|sed|cat|ls|find|grep|head|tail|nl|wc|pwd|tsc|vite)\s+/, (match) =>
      match.toLowerCase(),
    )
    .toLowerCase()

  if (/^git\s+(commit|push|pull|merge|checkout|switch|add|restore|reset)\b/.test(normalized)) {
    return { motion: "running", tool: "git" }
  }
  if (/^git\s+(status|diff|show|log|branch|rev-parse|ls-files)\b/.test(normalized)) {
    return { motion: "reading", tool: "git" }
  }
  if (/^(rg|grep|find)\b/.test(normalized) || /\brg\s+/.test(normalized)) {
    return { motion: "reading", tool: "search" }
  }
  if (/^(sed|cat|ls|head|tail|nl|wc|pwd)\b/.test(normalized)) {
    return { motion: "reading", tool: "search" }
  }
  if (
    /^(pnpm|npm)\s+(run\s+)?(build|test|lint|typecheck|check)\b/.test(normalized) ||
    /^node\s+--test\b/.test(normalized) ||
    /\b(tsc|vite\s+build)\b/.test(normalized)
  ) {
    return { motion: "running", tool: "test" }
  }
  return { motion: "running", tool: "shell" }
}

function classifyMcpTool(server, tool) {
  const serverName = String(server || "").toLowerCase()
  const toolName = String(tool || "").toLowerCase()

  if (serverName === "linear") {
    if (/^(get|list|search)(?:_|$)/.test(toolName)) {
      return { motion: "reading", tool: "linear" }
    }
    if (/^(save|update|create|delete|archive)(?:_|$)/.test(toolName)) {
      return { motion: "typing", tool: "linear" }
    }
    return { motion: "reading", tool: "linear" }
  }

  if (/^(get|list|search|read|find)(?:_|$)/.test(toolName)) {
    return { motion: "reading", tool: "other" }
  }
  if (/^(save|update|create|delete|write)(?:_|$)/.test(toolName)) {
    return { motion: "typing", tool: "other" }
  }
  return { motion: "running", tool: "other" }
}

function summarizeFileChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return "文件已更新"
  }
  const paths = changes
    .map((change) => shortPath(change?.path))
    .filter(Boolean)
    .slice(0, 2)
  const suffix = changes.length > 2 ? ` 等 ${changes.length} 个文件` : ""
  return cleanDetail(`${paths.join(", ")}${suffix}` || "文件已更新")
}

function summarizeTodos(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "任务清单已更新"
  }
  const completed = items.filter((item) => Boolean(item?.completed)).length
  const active = items.find((item) => !item?.completed)?.text || items.at(-1)?.text || ""
  return cleanDetail(`${completed}/${items.length} 完成 · ${active}`)
}

function detailFromFinal(run) {
  if (run.final && String(run.final).trim()) {
    return cleanDetail(run.final)
  }
  return run.exitCode === 0 ? "Codex 已正常结束" : "运行已结束"
}

function cleanDetail(value, limit = DETAIL_LIMIT) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) {
    return ""
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function shortPath(filePath) {
  const parts = String(filePath || "")
    .split(path.sep)
    .filter(Boolean)
  return parts.slice(-3).join("/")
}

function withActivity(base, activityKind, activityLabel, detail, { motion = "waiting", tool = "other" } = {}) {
  return {
    ...base,
    activityKind,
    activityMotion: motion,
    activityTool: tool,
    activityLabel,
    detail: cleanDetail(detail),
  }
}

function newestIso(updatedAt, mtimeMs) {
  const candidates = [Date.parse(updatedAt || "")]
  if (Number.isFinite(mtimeMs)) {
    candidates.push(mtimeMs)
  }
  const newest = Math.max(...candidates.filter(Number.isFinite))
  return Number.isFinite(newest) ? new Date(newest).toISOString() : new Date().toISOString()
}

function isRecent(updatedAt, thresholdMs = RECENT_EVENT_IDLE_MS) {
  const timestamp = Date.parse(updatedAt || "")
  return Number.isFinite(timestamp) && Date.now() - timestamp < thresholdMs
}

async function readActivityRun(store, runId) {
  const run = typeof store.getRunMetadata === "function"
    ? await store.getRunMetadata(runId)
    : await store.getRun(runId)
  if (!run || run.status !== "succeeded" || run.final !== undefined || !run.finalPath) {
    return run
  }
  return {
    ...run,
    final: await readOptionalText(run.finalPath),
  }
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      return ""
    }
    throw error
  }
}

function fallbackRunFromActive(activeRun) {
  return {
    id: activeRun.runId,
    projectKey: activeRun.projectKey,
    stage: activeRun.stage,
    issueIdentifier: activeRun.issue?.identifier,
    issueTitle: activeRun.issue?.title,
    status: "running",
    createdAt: activeRun.startedAt,
    updatedAt: activeRun.startedAt,
    pid: activeRun.pid,
    supervisorPid: activeRun.supervisorPid,
    codexPid: activeRun.codexPid,
    stdout: "",
  }
}
