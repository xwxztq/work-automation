import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "./config.mjs"
import { RUNS_DIR, STATE_DIR } from "./defaults.mjs"

export function createRunStore(rootDir) {
  const baseDir = path.join(rootDir, STATE_DIR)
  const runsDir = path.join(baseDir, RUNS_DIR)

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

  async function listRuns(limit = 50) {
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
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
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
    createRun,
    updateRun,
    appendText,
    listRuns,
    getRun,
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
