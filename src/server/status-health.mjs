import { createLinearClient } from "./linear-client.mjs"

export const REQUIRED_STATUS_KEYS = [
  "todo",
  "needsClarification",
  "blocked",
  "ready",
  "schedule",
  "inProgress",
  "testing",
  "readyForReview",
]

export const STATUS_LABELS = {
  todo: "Todo",
  needsClarification: "Needs Clarification",
  blocked: "Blocked",
  ready: "Ready for Codex",
  schedule: "On Schedule",
  inProgress: "In Progress",
  testing: "Testing",
  readyForReview: "Ready for Review",
}

export function configuredRequiredStatuses(config) {
  return REQUIRED_STATUS_KEYS.map((key) => ({
    key,
    label: STATUS_LABELS[key] || key,
    name: String(config.statuses?.[key] || "").trim(),
  })).filter((status) => status.name)
}

export async function checkLinearStatusHealth(config, options = {}) {
  const apiKeyEnv = config.linear?.apiKeyEnv || "LINEAR_API_KEY"
  const linear = options.linear || createLinearFromOptions({ ...options, apiKeyEnv })
  const projects = config.projects.filter((project) => project.enabled)
  const requiredStatuses = configuredRequiredStatuses(config)
  const checkedAt = new Date().toISOString()

  if (projects.length === 0) {
    return {
      ok: true,
      unavailable: false,
      checkedAt,
      requiredStatuses,
      errors: [],
      projects: [],
    }
  }

  if (!linear) {
    return {
      ok: false,
      unavailable: true,
      checkedAt,
      requiredStatuses,
      errors: [`未设置 ${apiKeyEnv}，无法检查 Linear 工作流状态。`],
      projects: projects.map((project) => emptyProjectHealth(project)),
    }
  }

  const projectResults = await Promise.all(
    projects.map((project) => checkLinearProjectStatusHealth(config, project, linear)),
  )
  const errors = projectResults.flatMap((project) => project.errors)
  return {
    ok: errors.length === 0 && projectResults.every((project) => project.ok),
    unavailable: false,
    checkedAt,
    requiredStatuses,
    errors,
    projects: projectResults,
  }
}

export async function checkLinearProjectStatusHealth(config, project, linear) {
  const base = emptyProjectHealth(project)
  const requiredStatuses = configuredRequiredStatuses(config)

  try {
    const result = await linear.listProjectWorkflowStates(project.linearProjectId)
    const teams = result.teams.map((team) => {
      const existingStatuses = (team.workflowStates || [])
        .map((state) => state.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
      const existingSet = new Set(existingStatuses)
      const missingStatuses = requiredStatuses.filter((status) => !existingSet.has(status.name))
      return {
        teamId: team.id,
        teamKey: team.key || "",
        teamName: team.name || team.key || team.id,
        existingStatuses,
        missingStatuses,
        ok: missingStatuses.length === 0,
      }
    })

    const errors = teams.length ? [] : [`${projectLabel(project)} 未关联任何 Linear 团队。`]
    return {
      ...base,
      ok: errors.length === 0 && teams.every((team) => team.ok),
      linearProjectName: result.project.name || "",
      linearProjectUrl: result.project.url || null,
      teams,
      errors,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base,
      ok: false,
      errors: [`${projectLabel(project)} 状态检查失败: ${message}`],
    }
  }
}

export function projectStatusHealthIsBlocking(projectHealth) {
  return !projectHealth?.ok
}

export function formatProjectStatusHealthBlock(projectHealth) {
  const missing = []
  for (const team of projectHealth.teams || []) {
    if (!team.missingStatuses?.length) {
      continue
    }
    missing.push(`${team.teamName}: ${team.missingStatuses.map((status) => status.name).join(", ")}`)
  }
  const details = [...(projectHealth.errors || []), ...missing]
  return details.length
    ? `Linear 工作流状态不完整，跳过项目 ${projectHealth.projectKey}: ${details.join("；")}`
    : `Linear 工作流状态不完整，跳过项目 ${projectHealth.projectKey}`
}

function createLinearFromOptions({ linear, apiKey, apiKeyEnv }) {
  if (linear) {
    return linear
  }
  const resolvedApiKey = apiKey || process.env[apiKeyEnv]
  return resolvedApiKey ? createLinearClient(resolvedApiKey) : null
}

function emptyProjectHealth(project) {
  return {
    projectKey: project.key,
    repoName: project.repoName || project.key,
    linearProjectId: project.linearProjectId,
    linearProjectName: "",
    linearProjectUrl: null,
    ok: false,
    teams: [],
    errors: [],
  }
}

function projectLabel(project) {
  return `${project.repoName || project.key} (${project.linearProjectId || "未配置 Linear 项目 ID"})`
}
