import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "./config.mjs"
import { EVENTS_FILE, PROCESSED_FILE, RUNS_DIR, STATE_DIR } from "./defaults.mjs"

export function createRunStore(rootDir) {
  const baseDir = path.join(rootDir, STATE_DIR)
  const runsDir = path.join(baseDir, RUNS_DIR)
  const eventsPath = path.join(baseDir, EVENTS_FILE)
  const processedPath = path.join(baseDir, PROCESSED_FILE)

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
    return run
  }

  async function updateRun(run, patch) {
    const next = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await writeJsonFile(next.metadataPath, next)
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
    const text = await fs.readFile(eventsPath, "utf8")
    const max = Math.max(1, Math.min(Number(limit || 200), 1000))
    const events = []
    for (const line of text.trim().split("\n").reverse()) {
      if (!line) {
        continue
      }
      try {
        const event = JSON.parse(line)
        if (projectKey && event.projectKey !== projectKey) {
          continue
        }
        events.push(event)
      } catch {
        events.push({
          timestamp: new Date(0).toISOString(),
          level: "error",
          type: "log-parse-error",
          message: line,
        })
      }
      if (events.length >= max) {
        break
      }
    }
    return events
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
