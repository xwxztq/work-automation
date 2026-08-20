import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "./config.mjs"
import { EVENTS_FILE, PROCESSED_FILE, RUNS_DIR, STATE_DIR } from "./defaults.mjs"

const EVENT_READ_CHUNK_BYTES = 64 * 1024
const RUNS_CACHE_TTL_MS = 250

export function createRunStore(rootDir) {
  const baseDir = path.join(rootDir, STATE_DIR)
  const runsDir = path.join(baseDir, RUNS_DIR)
  const eventsPath = path.join(baseDir, EVENTS_FILE)
  const processedPath = path.join(baseDir, PROCESSED_FILE)
  let runsVersion = 0
  let runsCache = null
  let runsRead = null

  async function createRun({ projectKey, stage, issue }) {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${projectKey}-${stage}-${issue.identifier || issue.id}-${randomUUID().slice(0, 8)}`
    const dir = path.join(runsDir, id)
    const run = {
      id,
      projectKey,
      stage,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      status: "running",
      cleanupReviewTempOnCompletion: stage === "part3",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dir,
      stdoutPath: path.join(dir, "stdout.jsonl"),
      stderrPath: path.join(dir, "stderr.log"),
      promptPath: path.join(dir, "prompt.md"),
      finalPath: path.join(dir, "final.txt"),
      metadataPath: path.join(dir, "run.json"),
    }
    await ensureDir(dir)
    await writeJsonFile(run.metadataPath, run)
    invalidateRunsCache()
    return run
  }

  async function updateRun(run, patch) {
    const persisted = await readJsonFile(run.metadataPath, run)
    const next = {
      ...run,
      ...persisted,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await writeJsonFile(next.metadataPath, next)
    invalidateRunsCache()
    return next
  }

  async function appendText(filePath, text) {
    await ensureDir(path.dirname(filePath))
    await fs.appendFile(filePath, text)
  }

  async function appendEvent(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "info",
      ...event,
    }
    await appendText(eventsPath, `${JSON.stringify(entry)}\n`)
    return entry
  }

  async function listEvents({ limit = 200, projectKey } = {}) {
    if (!(await fileExists(eventsPath))) {
      return []
    }
    return readRecentEvents(eventsPath, {
      limit: normalizeEventLimit(limit),
      projectKey,
    })
  }

  async function getProcessedIssue(projectKey, stage, issueId) {
    const state = await readProcessedState()
    return state.issues[processedIssueKey(projectKey, stage, issueId)] || null
  }

  async function setProcessedIssue({ projectKey, stage, issueId, issueIdentifier, fingerprint, issueUpdatedAt, stateName, runId }) {
    const state = await readProcessedState()
    state.issues[processedIssueKey(projectKey, stage, issueId)] = {
      projectKey,
      stage,
      issueId,
      issueIdentifier,
      fingerprint,
      issueUpdatedAt,
      stateName,
      runId,
      recordedAt: new Date().toISOString(),
    }
    await writeJsonFile(processedPath, state)
    return state.issues[processedIssueKey(projectKey, stage, issueId)]
  }

  async function listRuns(limit = 50, filters = {}) {
    const result = await listRunsWithTotal({ limit, ...filters })
    return result.runs
  }

  async function listRunsWithTotal({ limit = 50, projectKey } = {}) {
    const runs = await readRuns()
    const filteredRuns = projectKey ? runs.filter((run) => run.projectKey === projectKey) : runs
    const sortedRuns = filteredRuns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return {
      runs: sortedRuns.slice(0, limit),
      totalCount: sortedRuns.length,
    }
  }

  async function readRuns() {
    const now = Date.now()
    if (runsCache && runsCache.version === runsVersion && runsCache.expiresAt > now) {
      return [...runsCache.runs]
    }
    if (runsRead?.version === runsVersion) {
      return [...await runsRead.promise]
    }

    const version = runsVersion
    const promise = readRunsFromDisk().then((runs) => {
      if (runsVersion === version) {
        runsCache = {
          version,
          expiresAt: Date.now() + RUNS_CACHE_TTL_MS,
          runs,
        }
      }
      return runs
    })
    runsRead = { version, promise }
    try {
      return [...await promise]
    } finally {
      if (runsRead?.promise === promise) {
        runsRead = null
      }
    }
  }

  async function readRunsFromDisk() {
    if (!(await fileExists(runsDir))) {
      return []
    }
    const entries = await fs.readdir(runsDir, { withFileTypes: true })
    const runs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const metadataPath = path.join(runsDir, entry.name, "run.json")
      const run = await readJsonFile(metadataPath, null)
      if (run) {
        runs.push(run)
      }
    }
    return runs
  }

  function invalidateRunsCache() {
    runsVersion += 1
    runsCache = null
  }

  async function getRun(id) {
    const metadataPath = path.join(runsDir, id, "run.json")
    const run = await readJsonFile(metadataPath, null)
    if (!run) {
      return null
    }
    return {
      ...run,
      stdout: await readOptional(run.stdoutPath),
      stderr: await readOptional(run.stderrPath),
      final: await readOptional(run.finalPath),
      prompt: await readOptional(run.promptPath),
    }
  }

  return {
    baseDir,
    runsDir,
    eventsPath,
    processedPath,
    createRun,
    updateRun,
    appendText,
    appendEvent,
    listEvents,
    getProcessedIssue,
    setProcessedIssue,
    listRuns,
    listRunsWithTotal,
    getRun,
  }

  async function readProcessedState() {
    const state = await readJsonFile(processedPath, { version: 1, issues: {} })
    return {
      version: 1,
      issues: state?.issues && typeof state.issues === "object" ? state.issues : {},
    }
  }
}

function processedIssueKey(projectKey, stage, issueId) {
  return `${projectKey}:${stage}:${issueId}`
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

async function readRecentEvents(filePath, { limit, projectKey }) {
  const handle = await fs.open(filePath, "r")
  try {
    const { size } = await handle.stat()
    const events = []
    let position = size
    let carry = Buffer.alloc(0)

    while (position > 0 && events.length < limit) {
      const bytesToRead = Math.min(EVENT_READ_CHUNK_BYTES, position)
      position -= bytesToRead
      const chunk = Buffer.allocUnsafe(bytesToRead)
      const { bytesRead } = await handle.read(chunk, 0, bytesToRead, position)
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry])
      let lineEnd = combined.length

      for (let index = combined.length - 1; index >= 0 && events.length < limit; index -= 1) {
        if (combined[index] !== 0x0a) {
          continue
        }
        addEventLine(events, combined.subarray(index + 1, lineEnd), projectKey)
        lineEnd = index
      }
      carry = combined.subarray(0, lineEnd)
    }

    if (position === 0 && events.length < limit) {
      addEventLine(events, carry, projectKey)
    }
    return events
  } finally {
    await handle.close()
  }
}

function addEventLine(events, lineBuffer, projectKey) {
  if (lineBuffer.length === 0) {
    return
  }
  const line = lineBuffer.toString("utf8")
  try {
    const event = JSON.parse(line)
    if (!projectKey || event.projectKey === projectKey) {
      events.push(event)
    }
  } catch {
    events.push({
      timestamp: new Date(0).toISOString(),
      level: "error",
      type: "log-parse-error",
      message: line,
    })
  }
}

function normalizeEventLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value)) {
    return 200
  }
  return Math.max(1, Math.min(Math.trunc(value), 1000))
}
