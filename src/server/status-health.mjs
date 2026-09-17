import { createLinearClient } from "./linear-client.mjs"
import { auditIssueAdapter } from "./issue-audit.mjs"
import { createLinearReadAdapter } from "./linear-read-adapter.mjs"
import {
  ISSUE_PLATFORM_ERROR_CODE,
  ISSUE_PLATFORM_OPERATION,
  IssuePlatformError,
  normalizeIssuePlatformError,
} from "./issue-platform.mjs"

export const DEFAULT_STATUS_HEALTH_CACHE_TTL_MS = 60_000

export const REQUIRED_STATUS_KEYS = [
  "todo",
  "needsClarification",
  "tooLarge",
  "needsSplitting",
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
  tooLarge: "Too Large",
  needsSplitting: "Needs Splitting",
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

export function createLinearStatusHealthChecker({ ttlMs = DEFAULT_STATUS_HEALTH_CACHE_TTL_MS } = {}) {
  let cache = null
  let inflight = null

  return {
    async check(config, options = {}) {
      const cacheKey = statusHealthCacheKey(config, options)
      const now = Date.now()
      if (!options.force && cache?.key === cacheKey && now - cache.checkedAtMs < ttlMs) {
        return cache.result
      }
      if (!options.force && inflight?.key === cacheKey) {
        return inflight.promise
      }

      const promise = checkLinearStatusHealth(config, options).then((result) => {
        cache = {
          key: cacheKey,
          checkedAtMs: Date.now(),
          result,
        }
        return result
      })
      inflight = { key: cacheKey, promise }
      try {
        return await promise
      } finally {
        if (inflight?.promise === promise) {
          inflight = null
        }
      }
    },
    clear() {
      cache = null
      inflight = null
    },
  }
}

export async function checkLinearStatusHealth(config, options = {}) {
  const apiKeyEnv = options.apiKeyEnv || config.linear?.apiKeyEnv || "LINEAR_API_KEY"
  const linear = auditIssueAdapter(options.linear || createLinearFromOptions({ ...options, apiKeyEnv }), options.store, { stage: "status-health", projects: config.projects })
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
      readErrors: [],
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
      readErrors: [],
      projects: projects.map((project) => emptyProjectHealth(project)),
    }
  }

  const projectResults = await checkLinearProjectsStatusHealth(config, projects, linear)
  const errors = projectResults.flatMap((project) => project.errors)
  const readErrors = projectResults
    .filter((project) => project.readError)
    .map((project) => ({
      projectKey: project.projectKey,
      ...project.readError,
    }))
  return {
    ok: errors.length === 0 && projectResults.every((project) => project.ok),
    unavailable: readErrors.some((error) => [
      ISSUE_PLATFORM_ERROR_CODE.PERMISSION_DENIED,
      ISSUE_PLATFORM_ERROR_CODE.RATE_LIMITED,
      ISSUE_PLATFORM_ERROR_CODE.UNAVAILABLE,
      ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED,
    ].includes(error.code)),
    checkedAt,
    requiredStatuses,
    errors,
    readErrors,
    projects: projectResults,
  }
}

export async function checkLinearProjectStatusHealth(config, project, linear) {
  const base = emptyProjectHealth(project)

  try {
    const result = await linear.listProjectWorkflowStates(project.linearProjectId)
    return projectHealthFromWorkflowStateResult(config, project, result)
  } catch (error) {
    const readError = normalizeStatusHealthReadError(error)
    return {
      ...base,
      ok: false,
      readError,
      errors: [`${projectLabel(project)} 状态检查失败: ${readError.message}`],
    }
  }
}

export function linearStatusHealthIsBlocking(health) {
  return !health?.ok
}

export function projectStatusHealthIsBlocking(projectHealth) {
  return !projectHealth?.ok
}

export function formatLinearStatusHealthBlock(health) {
  const blockingProjects = (health?.projects || []).filter(projectStatusHealthIsBlocking)
  const projectDetails = blockingProjects.map((project) => {
    const details = projectStatusHealthDetails(project)
    return details ? `${project.projectKey}: ${details}` : project.projectKey
  })
  const details = [...(health?.errors || []), ...projectDetails]
  if (!details.length) {
    return "Linear 工作流状态不完整，跳过本轮扫描"
  }
  const shown = details.slice(0, 5)
  const suffix = details.length > shown.length ? `；另有 ${details.length - shown.length} 项` : ""
  return `Linear 工作流状态不完整，跳过本轮扫描: ${shown.join("；")}${suffix}`
}

export function formatProjectStatusHealthBlock(projectHealth) {
  const details = projectStatusHealthDetails(projectHealth)
  return details.length
    ? `Linear 工作流状态不完整，跳过项目 ${projectHealth.projectKey}: ${details}`
    : `Linear 工作流状态不完整，跳过项目 ${projectHealth.projectKey}`
}

async function checkLinearProjectsStatusHealth(config, projects, linear) {
  if (typeof linear.listProjectsWorkflowStates !== "function") {
    return Promise.all(projects.map((project) => checkLinearProjectStatusHealth(config, project, linear)))
  }

  try {
    const uniqueProjectIds = [...new Set(projects.map((project) => project.linearProjectId).filter(Boolean))]
    const results = await linear.listProjectsWorkflowStates(uniqueProjectIds)
    const resultsByProjectId = new Map(results.map((result) => [result.requestedProjectId || result.project?.id, result]))
    return projects.map((project) => {
      const result = resultsByProjectId.get(project.linearProjectId)
      if (!result) {
        return {
          ...emptyProjectHealth(project),
          ok: false,
          errors: [`${projectLabel(project)} 状态检查失败: 未找到 Linear 项目。`],
        }
      }
      if (result.error) {
        const readError = normalizeStatusHealthReadError(result.error)
        return {
          ...emptyProjectHealth(project),
          ok: false,
          readError,
          errors: [`${projectLabel(project)} 状态检查失败: ${readError.message}`],
        }
      }
      if (result.complete === false) {
        const readError = new IssuePlatformError({
          code: ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED,
          operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
          retryable: true,
        }).toJSON()
        return {
          ...emptyProjectHealth(project),
          ok: false,
          readError,
          errors: [`${projectLabel(project)} 状态检查失败: Linear 读取不完整，${readError.message}`],
        }
      }
      return projectHealthFromWorkflowStateResult(config, project, result)
    })
  } catch (error) {
    const readError = normalizeStatusHealthReadError(error)
    return projects.map((project) => ({
      ...emptyProjectHealth(project),
      ok: false,
      readError,
      errors: [`${projectLabel(project)} 状态检查失败: ${readError.message}`],
    }))
  }
}

function projectHealthFromWorkflowStateResult(config, project, result) {
  const base = emptyProjectHealth(project)
  const requiredStatuses = configuredRequiredStatuses(config)
  const teams = (result.teams || []).map((team) => {
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
}

function projectStatusHealthDetails(projectHealth) {
  const missing = []
  for (const team of projectHealth.teams || []) {
    if (!team.missingStatuses?.length) {
      continue
    }
    missing.push(`${team.teamName}: ${team.missingStatuses.map((status) => status.name).join(", ")}`)
  }
  return [...(projectHealth.errors || []), ...missing].join("；")
}

function createLinearFromOptions({ linear, linearClient, apiKey, apiKeyEnv }) {
  if (linear) {
    return linear
  }
  if (linearClient) {
    return createLinearReadAdapter(linearClient)
  }
  const resolvedApiKey = apiKey || process.env[apiKeyEnv]
  return resolvedApiKey
    ? createLinearReadAdapter(createLinearClient(resolvedApiKey))
    : null
}

function statusHealthCacheKey(config, options = {}) {
  const apiKeyEnv = options.apiKeyEnv || config.linear?.apiKeyEnv || "LINEAR_API_KEY"
  const projects = config.projects
    .filter((project) => project.enabled)
    .map((project) => ({
      key: project.key,
      linearProjectId: project.linearProjectId,
    }))
    .sort((a, b) => `${a.key}:${a.linearProjectId}`.localeCompare(`${b.key}:${b.linearProjectId}`))
  return JSON.stringify({
    apiKeyEnv,
    apiKeyAvailable: Boolean(
      options.linear ||
      options.linearClient ||
      options.apiKey ||
      process.env[apiKeyEnv],
    ),
    projects,
    statuses: configuredRequiredStatuses(config),
  })
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
    readError: null,
  }
}

function normalizeStatusHealthReadError(error) {
  if (error instanceof IssuePlatformError) {
    return error.toJSON()
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return new IssuePlatformError({
      code: error.code,
      operation: error.operation || ISSUE_PLATFORM_OPERATION.READ_ISSUE,
      path: error.path,
      retryable: error.retryable,
    }).toJSON()
  }
  return normalizeIssuePlatformError(error, {
    code: ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
    operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
  })
}

function projectLabel(project) {
  return `${project.repoName || project.key} (${project.linearProjectId || "未配置 Linear 项目 ID"})`
}
