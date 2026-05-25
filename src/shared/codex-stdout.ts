export type CodexStdoutEventKind =
  | "message"
  | "command"
  | "tool"
  | "file"
  | "todo"
  | "search"
  | "lifecycle"
  | "error"
  | "other"

export type CodexStdoutEventStatus = "running" | "completed" | "failed" | "updated" | "event"

export type CodexStdoutEvent = {
  id: string
  sequence: number
  lineNumber: number
  kind: CodexStdoutEventKind
  status: CodexStdoutEventStatus
  title: string
  summary: string
  preview: string
  detail: string
  rawPayload: string
  outputBytes: number
  canExpand: boolean
}

export type CodexStdoutStats = {
  rawBytes: number
  rawLines: number
  parsedLines: number
  malformedLines: number
  eventCount: number
  messageCount: number
  commandCount: number
  toolCount: number
  errorCount: number
  longEventCount: number
}

export type CodexStdoutParseResult = {
  isStructured: boolean
  events: CodexStdoutEvent[]
  stats: CodexStdoutStats
  rawText: string
}

type JsonRecord = Record<string, unknown>

const PREVIEW_LIMIT = 260
const SUMMARY_LIMIT = 180
const TITLE_LIMIT = 140
const LONG_DETAIL_BYTES = 1_024
const encoder = new TextEncoder()

export function parseCodexStdout(text: string): CodexStdoutParseResult {
  const rawText = String(text || "")
  const events: CodexStdoutEvent[] = []
  const eventsByItemId = new Map<string, CodexStdoutEvent>()
  const lines = rawText.split("\n")
  let rawLines = 0
  let parsedLines = 0
  let malformedLines = 0
  let sequence = 0

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    rawLines += 1
    sequence += 1

    const payload = parseJsonRecord(trimmed)
    if (!payload) {
      malformedLines += 1
      continue
    }

    parsedLines += 1

    const eventType = stringValue(payload.type) || "event"
    const item = recordValue(payload.item)
    if (item) {
      const nextEvent = stdoutEventFromItem({
        item,
        eventType,
        sequence,
        lineNumber: index + 1,
        rawPayload: stringifyPayload(payload),
      })
      const existing = eventsByItemId.get(nextEvent.id)
      if (existing) {
        mergeStdoutEvent(existing, nextEvent)
      } else {
        eventsByItemId.set(nextEvent.id, nextEvent)
        events.push(nextEvent)
      }
      continue
    }

    events.push(stdoutEventFromEnvelope(payload, eventType, sequence, index + 1))
  }

  const orderedEvents = events.sort((a, b) => b.sequence - a.sequence)
  const stats = buildStats(rawText, rawLines, parsedLines, malformedLines, orderedEvents)

  return {
    isStructured: parsedLines > 0 && orderedEvents.length > 0,
    events: orderedEvents,
    stats,
    rawText,
  }
}

function stdoutEventFromItem({
  item,
  eventType,
  sequence,
  lineNumber,
  rawPayload,
}: {
  item: JsonRecord
  eventType: string
  sequence: number
  lineNumber: number
  rawPayload: string
}): CodexStdoutEvent {
  const itemType = stringValue(item.type) || "other"
  const itemId = stringValue(item.id) || `${itemType}:${lineNumber}`
  const status = statusFromItem(eventType, item)

  if (itemType === "agent_message") {
    const detail = stringValue(item.text)
    return createStdoutEvent({
      id: `item:${itemId}`,
      sequence,
      lineNumber,
      kind: "message",
      status,
      title: "Agent 消息",
      summary: detail || "消息为空",
      detail,
      rawPayload,
    })
  }

  if (itemType === "command_execution") {
    const command = summarizeCommand(stringValue(item.command))
    const output = stringValue(item.aggregated_output)
    const exitCode = numberValue(item.exit_code)
    const commandStatus = typeof exitCode === "number" && exitCode !== 0 ? "failed" : status
    const summary = output || (commandStatus === "running" ? "命令仍在运行，等待输出" : "无命令输出")
    return createStdoutEvent({
      id: `item:${itemId}`,
      sequence,
      lineNumber,
      kind: "command",
      status: commandStatus,
      title: command || "命令执行",
      summary,
      detail: output || command,
      rawPayload,
    })
  }

  if (itemType === "mcp_tool_call") {
    const server = stringValue(item.server)
    const tool = stringValue(item.tool)
    const name = [server, tool].filter(Boolean).join(".") || "MCP 工具调用"
    const error = item.error
    const result = item.result
    const detail = error ? stringifyUnknown(error) : stringifyUnknown(result) || stringifyUnknown(item.arguments)
    return createStdoutEvent({
      id: `item:${itemId}`,
      sequence,
      lineNumber,
      kind: "tool",
      status: error ? "failed" : status,
      title: name,
      summary: detail || "工具调用已记录",
      detail,
      rawPayload,
    })
  }

  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return createStdoutEvent({
      id: `item:${itemId}`,
      sequence,
      lineNumber,
      kind: "file",
      status,
      title: "文件改动",
      summary: summarizeFileChanges(changes),
      detail: stringifyUnknown(item.changes),
      rawPayload,
    })
  }

  if (itemType === "todo_list") {
    const items = Array.isArray(item.items) ? item.items : []
    return createStdoutEvent({
      id: `item:${itemId}`,
      sequence,
      lineNumber,
      kind: "todo",
      status,
      title: "任务清单",
      summary: summarizeTodos(items),
      detail: stringifyUnknown(item.items),
      rawPayload,
    })
  }

  if (itemType === "web_search") {
    const query = stringValue(item.query) || stringValue(item.text)
    return createStdoutEvent({
      id: `item:${itemId}`,
      sequence,
      lineNumber,
      kind: "search",
      status,
      title: "搜索",
      summary: query || "搜索事件",
      detail: stringifyUnknown(item),
      rawPayload,
    })
  }

  return createStdoutEvent({
    id: `item:${itemId}`,
    sequence,
    lineNumber,
    kind: "other",
    status,
    title: itemType,
    summary: stringifyUnknown(item) || "事件已记录",
    detail: stringifyUnknown(item),
    rawPayload,
  })
}

function stdoutEventFromEnvelope(
  payload: JsonRecord,
  eventType: string,
  sequence: number,
  lineNumber: number,
): CodexStdoutEvent {
  if (eventType === "error") {
    const message = stringValue(payload.message) || stringifyUnknown(payload)
    return createStdoutEvent({
      id: `event:${lineNumber}`,
      sequence,
      lineNumber,
      kind: "error",
      status: "failed",
      title: "错误",
      summary: message || "Codex 事件流错误",
      detail: stringifyUnknown(payload),
      rawPayload: stringifyPayload(payload),
    })
  }

  const title = lifecycleTitle(eventType)
  const summary = lifecycleSummary(payload, eventType)
  return createStdoutEvent({
    id: `event:${lineNumber}`,
    sequence,
    lineNumber,
    kind: "lifecycle",
    status: "event",
    title,
    summary,
    detail: stringifyUnknown(payload),
    rawPayload: stringifyPayload(payload),
  })
}

function createStdoutEvent({
  id,
  sequence,
  lineNumber,
  kind,
  status,
  title,
  summary,
  detail,
  rawPayload,
}: Omit<CodexStdoutEvent, "preview" | "outputBytes" | "canExpand">): CodexStdoutEvent {
  const normalizedDetail = String(detail || "")
  const outputBytes = byteSize(normalizedDetail)
  const preview = shortPreview(normalizedDetail || summary)
  const canExpand =
    Boolean(normalizedDetail) &&
    (normalizedDetail.length > preview.length || outputBytes > LONG_DETAIL_BYTES || rawPayload.length > preview.length)

  return {
    id,
    sequence,
    lineNumber,
    kind,
    status,
    title: cleanText(title, TITLE_LIMIT),
    summary: cleanText(summary, SUMMARY_LIMIT),
    preview,
    detail: normalizedDetail,
    rawPayload,
    outputBytes,
    canExpand,
  }
}

function mergeStdoutEvent(target: CodexStdoutEvent, next: CodexStdoutEvent) {
  target.sequence = Math.max(target.sequence, next.sequence)
  target.lineNumber = next.lineNumber
  target.status = next.status
  target.title = next.title || target.title
  target.summary = next.summary || target.summary
  target.preview = next.preview || target.preview
  target.detail = next.detail || target.detail
  target.rawPayload = next.rawPayload || target.rawPayload
  target.outputBytes = Math.max(target.outputBytes, next.outputBytes)
  target.canExpand = target.canExpand || next.canExpand
}

function buildStats(
  rawText: string,
  rawLines: number,
  parsedLines: number,
  malformedLines: number,
  events: CodexStdoutEvent[],
): CodexStdoutStats {
  return {
    rawBytes: byteSize(rawText),
    rawLines,
    parsedLines,
    malformedLines,
    eventCount: events.length,
    messageCount: events.filter((event) => event.kind === "message").length,
    commandCount: events.filter((event) => event.kind === "command").length,
    toolCount: events.filter((event) => event.kind === "tool").length,
    errorCount: events.filter((event) => event.kind === "error" || event.status === "failed").length,
    longEventCount: events.filter((event) => event.canExpand && event.outputBytes > LONG_DETAIL_BYTES).length,
  }
}

function statusFromItem(eventType: string, item: JsonRecord): CodexStdoutEventStatus {
  const itemStatus = stringValue(item.status)
  if (item.error) {
    return "failed"
  }
  if (itemStatus === "failed") {
    return "failed"
  }
  if (itemStatus === "in_progress" || eventType === "item.started") {
    return "running"
  }
  if (itemStatus === "completed" || eventType === "item.completed") {
    return "completed"
  }
  if (eventType === "item.updated") {
    return "updated"
  }
  return "event"
}

function summarizeCommand(command: string) {
  const text = String(command || "").trim()
  const shellMatch = text.match(/^\/bin\/zsh -lc ['"]([\s\S]*)['"]$/)
  return cleanText(shellMatch?.[1] || text || "执行命令", TITLE_LIMIT)
}

function summarizeFileChanges(changes: unknown[]) {
  if (changes.length === 0) {
    return "文件已更新"
  }
  const paths = changes
    .map((change) => stringValue(recordValue(change)?.path))
    .filter(Boolean)
    .slice(0, 3)
  const suffix = changes.length > 3 ? ` 等 ${changes.length} 个文件` : ""
  return cleanText(`${paths.join(", ")}${suffix}` || "文件已更新", SUMMARY_LIMIT)
}

function summarizeTodos(items: unknown[]) {
  if (items.length === 0) {
    return "任务清单已更新"
  }
  const todoRecords = items.map(recordValue).filter(isJsonRecord)
  const completed = todoRecords.filter((item) => Boolean(item.completed)).length
  const active = todoRecords.find((item) => !item.completed)
  const activeText = stringValue(active?.text) || stringValue(todoRecords.at(-1)?.text)
  return cleanText(`${completed}/${todoRecords.length} 完成${activeText ? ` · ${activeText}` : ""}`, SUMMARY_LIMIT)
}

function lifecycleTitle(eventType: string) {
  if (eventType === "thread.started") return "线程开始"
  if (eventType === "turn.started") return "回合开始"
  if (eventType === "turn.completed") return "回合完成"
  return eventType || "事件"
}

function lifecycleSummary(payload: JsonRecord, eventType: string) {
  if (eventType === "thread.started") {
    return stringValue(payload.thread_id) || "线程已开始"
  }
  if (eventType === "turn.completed") {
    const usage = recordValue(payload.usage)
    const inputTokens = numberValue(usage?.input_tokens)
    const outputTokens = numberValue(usage?.output_tokens)
    if (typeof inputTokens === "number" || typeof outputTokens === "number") {
      return `tokens in ${inputTokens ?? "-"} / out ${outputTokens ?? "-"}`
    }
  }
  return stringifyUnknown(payload) || eventType
}

function shortPreview(value: string) {
  const lines = String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 3)
    .join("\n")
  return cleanText(lines || value, PREVIEW_LIMIT)
}

function cleanText(value: unknown, limit: number) {
  const text = String(value || "")
    .replace(/\t/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .trim()
  if (!text) {
    return ""
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function byteSize(value: string) {
  return encoder.encode(String(value || "")).byteLength
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return recordValue(parsed)
  } catch {
    return null
  }
}

function recordValue(value: unknown): JsonRecord | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord
  }
  return null
}

function isJsonRecord(value: JsonRecord | null): value is JsonRecord {
  return Boolean(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringifyPayload(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function stringifyUnknown(value: unknown) {
  if (value === null || typeof value === "undefined") {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
