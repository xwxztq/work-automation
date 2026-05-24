import fs from "node:fs/promises"
import path from "node:path"

const RECENT_EVENT_IDLE_MS = 12_000
const DETAIL_LIMIT = 96

export async function createCodexActivityPayload({ scheduler, store, projectKey }) {
  const status = await scheduler.status()
  const activeRuns = status.activeRuns.filter((run) => !projectKey || run.projectKey === projectKey)
  const agents = []

  for (const activeRun of activeRuns) {
    const run = await store.getRun(activeRun.runId)
    const summary = run || fallbackRunFromActive(activeRun)
    agents.push(
      summarizeCodexRun(summary, {
        activeRun,
        stdoutMtimeMs: await readMtimeMs(summary.stdoutPath),
      }),
    )
  }

  return {
    generatedAt: new Date().toISOString(),
    agents: agents.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))),
  }
}

export function summarizeCodexRun(run, fsInfo = {}) {
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
  if (run.codexStarted === false || (!base.codexPid && !run.stdout)) {
    return withActivity(base, "booting", "启动中", cleanDetail(run.startupError || "等待 Codex 子进程"), {
      motion: "waiting",
      tool: "other",
    })
  }

  const activity = inferActivityFromStdout(String(run.stdout || ""), base.updatedAt)
  return withActivity(base, activity.kind, activity.label, activity.detail, {
    motion: activity.motion,
    tool: activity.tool,
  })
}

function inferActivityFromStdout(stdout, updatedAt) {
  const activeItems = new Map()
  let latestActivity = null
  let latestError = null
  let latestMessage = null

  for (const event of parseJsonl(stdout)) {
    if (event.type === "error") {
      latestError = event
      latestActivity = {
        kind: "waiting",
        label: "等待恢复",
        detail: cleanDetail(event.message || "Codex 连接暂时不可用"),
        motion: "waiting",
        tool: "other",
      }
      continue
    }

    const item = event.item
    if (!item || typeof item !== "object") {
      if (event.type === "turn.started") {
        latestActivity = {
          kind: "thinking",
          label: "思考中",
          detail: "新回合已开始",
          motion: "reading",
          tool: "other",
        }
      }
      continue
    }

    const id = item.id || `${event.type}:${activeItems.size}`
    const itemActivity = activityFromItem(item)
    if (!itemActivity) {
      continue
    }

    if (item.type === "agent_message") {
      latestMessage = item
    }

    if (event.type === "item.started") {
      activeItems.set(id, itemActivity)
      latestActivity = itemActivity
      continue
    }

    if (event.type === "item.completed") {
      activeItems.delete(id)
      latestActivity = itemActivity
      continue
    }

    if (event.type === "item.updated") {
      latestActivity = itemActivity
    }
  }

  const active = [...activeItems.values()].at(-1)
  if (active) {
    return active
  }

  if (latestActivity && isRecent(updatedAt)) {
    return latestActivity
  }

  if (latestError && isRecent(updatedAt, RECENT_EVENT_IDLE_MS * 3)) {
    return {
      kind: "waiting",
      label: "等待恢复",
      detail: cleanDetail(latestError.message || "Codex 连接暂时不可用"),
      motion: "waiting",
      tool: "other",
    }
  }

  if (latestMessage) {
    return {
      kind: "thinking",
      label: "整理输出",
      detail: cleanDetail(latestMessage.text || "Codex 正在汇总结果"),
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

async function readMtimeMs(filePath) {
  if (!filePath) {
    return null
  }
  try {
    return (await fs.stat(filePath)).mtimeMs
  } catch {
    return null
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
