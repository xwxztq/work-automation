import fs from "node:fs/promises"
import path from "node:path"
import { ensureDir, fileExists } from "./config.mjs"

const STAGES = new Set(["part1", "part2"])

export function promptPath(rootDir, scope, stage) {
  if (!STAGES.has(stage)) {
    throw new Error(`Invalid prompt stage: ${stage}`)
  }
  if (scope === "global") {
    return path.join(rootDir, "prompts", `${stage}.global.md`)
  }
  return path.join(rootDir, "prompts", "projects", `${scope}.${stage}.md`)
}

export async function readPrompt(rootDir, scope, stage) {
  const filePath = promptPath(rootDir, scope, stage)
  if (!(await fileExists(filePath)) && scope !== "global") {
    return readPrompt(rootDir, "global", stage)
  }
  return fs.readFile(filePath, "utf8")
}

export async function writePrompt(rootDir, scope, stage, content) {
  const filePath = promptPath(rootDir, scope, stage)
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`)
  return { filePath }
}

export async function readAllPrompts(rootDir, projects) {
  const global = {
    part1: await readPrompt(rootDir, "global", "part1"),
    part2: await readPrompt(rootDir, "global", "part2"),
  }
  const projectPrompts = {}
  for (const project of projects) {
    projectPrompts[project.key] = {
      part1: await readPrompt(rootDir, project.key, "part1"),
      part2: await readPrompt(rootDir, project.key, "part2"),
      part1IsOverride: await fileExists(promptPath(rootDir, project.key, "part1")),
      part2IsOverride: await fileExists(promptPath(rootDir, project.key, "part2")),
    }
  }
  return { global, projects: projectPrompts }
}

export function renderPrompt(template, context) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = context[key]
    if (Array.isArray(value)) {
      return value.join("\n")
    }
    return value == null ? "" : String(value)
  })
}

export function buildPromptContext(config, project) {
  const statuses = config.statuses
  return {
    SERVER_ID: config.serverId,
    PROJECT_KEY: project.key,
    REPO_NAME: project.repoName,
    CODEX_CWD: project.codexCwd || project.path,
    LINEAR_PROJECT_ID: project.linearProjectId,
    BRANCH_OR_SCOPE_PREFIX: project.branchOrScopePrefix || project.key,
    DEFAULT_TEST_COMMANDS: (project.defaultTests || []).map((command) => `- ${command}`),
    EXTRA_RULES: project.extraRules || "No extra project-specific rules.",
    STATUS_TODO: statuses.todo,
    STATUS_NEEDS_CLARIFICATION: statuses.needsClarification,
    STATUS_BLOCKED: statuses.blocked,
    STATUS_READY: statuses.ready,
    STATUS_SCHEDULE: statuses.schedule,
    STATUS_IN_PROGRESS: statuses.inProgress,
    STATUS_TESTING: statuses.testing,
  }
}

export function extractJson(text) {
  const trimmed = String(text || "").trim()
  if (!trimmed) {
    return null
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim())
      } catch {
        return null
      }
    }
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}
