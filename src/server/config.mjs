import fs from "node:fs/promises"
import path from "node:path"
import { accessSync, constants } from "node:fs"
import { DEFAULT_CONFIG } from "./defaults.mjs"
import { resolveExecutable } from "./executable.mjs"
import { isLoopbackHost, validateHost } from "./host.mjs"
import { validateProjectKeys } from "./project-key.mjs"

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
  const current = normalizeConfig(await readJsonFile(resolved, DEFAULT_CONFIG))
  const projectKeyValidation = validateProjectKeys(normalized.projects, {
    previousProjects: current.projects,
    allowUnsafeExisting: true,
  })
  if (projectKeyValidation.errors.length) {
    throw new Error(projectKeyValidation.errors.join("\n"))
  }
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
  config.projects = config.projects.map((project) => {
    const normalized = {
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
      part3PromptMode: "global",
      extraRules: "无额外项目规则。",
      ...project,
      defaultTests: Array.isArray(project.defaultTests)
        ? project.defaultTests
        : String(project.defaultTests || "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
      maxActivePart2: Number(project.maxActivePart2 || 1),
    }
    if (!normalized.codexCwd) {
      normalized.codexCwd = normalized.path
    }
    return normalized
  })

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

export async function validateConfig(config, rootDir = process.cwd(), options = {}) {
  const errors = []
  const warnings = []
  const apiKeyEnv = config.linear?.apiKeyEnv || "LINEAR_API_KEY"

  if (!config.serverId?.trim()) {
    errors.push("必须填写 serverId。")
  }
  const hostError = validateHost(config.host)
  if (hostError) {
    errors.push(hostError)
  } else if (!isLoopbackHost(config.host)) {
    warnings.push("当前 host 会把服务暴露到局域网，请确认只在可信网络中使用。")
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
  const codexBin = config.codex?.bin || DEFAULT_CONFIG.codex.bin
  if (!(await resolveExecutable(codexBin, { cwd: rootDir }))) {
    warnings.push(
      `当前进程 PATH 中找不到 codex.bin (${codexBin})。事项执行时可能直接启动失败；建议改成绝对路径或在启动服务前补齐 PATH。`,
    )
  }

  const projectKeyValidation = validateProjectKeys(config.projects, {
    previousProjects: options.previousConfig?.projects || config.projects,
    allowUnsafeExisting: true,
  })
  errors.push(...projectKeyValidation.errors)
  warnings.push(...projectKeyValidation.warnings)

  for (const [index, project] of config.projects.entries()) {
    const label = project.key || `projects[${index}]`
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
    "readyForReview",
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
