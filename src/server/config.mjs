import fs from "node:fs/promises"
import path from "node:path"
import { accessSync, constants } from "node:fs"
import { DEFAULT_CONFIG } from "./defaults.mjs"

export function resolveFromRoot(rootDir, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath)
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback
    }
    throw error
  }
}

export async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  await fs.rename(`${filePath}.tmp`, filePath)
}

export async function loadConfig(configPath, rootDir = process.cwd()) {
  const resolved = resolveFromRoot(rootDir, configPath)
  const raw = await readJsonFile(resolved, DEFAULT_CONFIG)
  return normalizeConfig(raw)
}

export async function saveConfig(configPath, config, rootDir = process.cwd()) {
  const resolved = resolveFromRoot(rootDir, configPath)
  const normalized = normalizeConfig(config)
  await writeJsonFile(resolved, normalized)
  return normalized
}

export function normalizeConfig(raw) {
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    linear: { ...DEFAULT_CONFIG.linear, ...(raw?.linear || {}) },
    codex: { ...DEFAULT_CONFIG.codex, ...(raw?.codex || {}) },
    statuses: { ...DEFAULT_CONFIG.statuses, ...(raw?.statuses || {}) },
    projects: Array.isArray(raw?.projects) ? raw.projects : [],
  }

  config.port = Number(config.port || DEFAULT_CONFIG.port)
  config.pollIntervalSeconds = Number(
    config.pollIntervalSeconds || DEFAULT_CONFIG.pollIntervalSeconds,
  )
  config.projects = config.projects.map((project) => ({
    key: "",
    enabled: true,
    linearProjectId: "",
    repoName: "",
    path: "",
    codexCwd: "",
    branchOrScopePrefix: "",
    maxActivePart2: 1,
    defaultTests: [],
    part1PromptMode: "global",
    part2PromptMode: "global",
    extraRules: "无额外项目规则。",
    ...project,
    defaultTests: Array.isArray(project.defaultTests)
      ? project.defaultTests
      : String(project.defaultTests || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
    maxActivePart2: Number(project.maxActivePart2 || 1),
  }))

  return config
}

export function redactConfig(config) {
  const apiKeyEnv = config.linear?.apiKeyEnv || "LINEAR_API_KEY"
  return {
    ...config,
    linear: {
      ...config.linear,
      apiKeySet: Boolean(process.env[apiKeyEnv]),
    },
  }
}

export async function validateConfig(config, rootDir = process.cwd()) {
  const errors = []
  const warnings = []
  const apiKeyEnv = config.linear?.apiKeyEnv || "LINEAR_API_KEY"

  if (!config.serverId?.trim()) {
    errors.push("必须填写 serverId。")
  }
  if (config.host !== "127.0.0.1") {
    warnings.push("当前版本建议 GUI 只监听 127.0.0.1。")
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    errors.push("port 必须是 1 到 65535 之间的整数。")
  }
  if (!Number.isFinite(config.pollIntervalSeconds) || config.pollIntervalSeconds < 10) {
    errors.push("pollIntervalSeconds 必须至少为 10。")
  }
  if (!process.env[apiKeyEnv]) {
    warnings.push(`当前进程环境未设置 ${apiKeyEnv}。`)
  }

  const keys = new Set()
  for (const [index, project] of config.projects.entries()) {
    const label = project.key || `projects[${index}]`
    if (!project.key?.trim()) {
      errors.push(`第 ${index + 1} 个项目缺少 key。`)
    }
    if (project.key && keys.has(project.key)) {
      errors.push(`项目 key 重复: ${project.key}`)
    }
    keys.add(project.key)
    if (!project.linearProjectId?.trim()) {
      errors.push(`${label}: 必须填写 linearProjectId。`)
    }
    if (!project.repoName?.trim()) {
      errors.push(`${label}: 必须填写 repoName。`)
    }
    const repoPath = project.path ? resolveFromRoot(rootDir, project.path) : ""
    const codexCwd = project.codexCwd
      ? resolveFromRoot(rootDir, project.codexCwd)
      : repoPath
    if (!repoPath) {
      errors.push(`${label}: 必须填写 path。`)
    } else {
      validateReadableDirectory(repoPath, `${label}: path`, errors)
    }
    if (!codexCwd) {
      errors.push(`${label}: 必须填写 codexCwd。`)
    } else {
      validateReadableDirectory(codexCwd, `${label}: codexCwd`, errors)
    }
  }

  for (const statusKey of [
    "todo",
    "needsClarification",
    "blocked",
    "ready",
    "schedule",
    "inProgress",
    "testing",
  ]) {
    if (!config.statuses?.[statusKey]?.trim()) {
      errors.push(`必须填写 statuses.${statusKey}。`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  }
}

function validateReadableDirectory(dirPath, label, errors) {
  try {
    accessSync(dirPath, constants.R_OK)
  } catch {
    errors.push(`${label} 不存在或不可读: ${dirPath}`)
  }
}
