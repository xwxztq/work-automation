export const DEFAULT_WORKSPACE_ID = "default"

export function activeWorkspaceId(config) {
  return config.linear?.activeWorkspaceId || DEFAULT_WORKSPACE_ID
}

export function projectWorkspaceId(project) {
  return project.workspaceId || DEFAULT_WORKSPACE_ID
}

export function linearWorkspaces(config) {
  const linear = config.linear || {}
  return [{
    id: DEFAULT_WORKSPACE_ID,
    name: "默认工作区",
    mode: "isolated",
    ...linear.defaultWorkspace,
    apiKeyEnv: String(linear.apiKeyEnv || "LINEAR_API_KEY").trim(),
  }, ...(linear.workspaces || [])]
}

export function workspaceConfig(config, workspaceId = activeWorkspaceId(config)) {
  const workspace = linearWorkspaces(config).find((item) => item.id === workspaceId)
  if (!workspace) throw new Error("Linear 工作区不存在。")
  return {
    ...config,
    linear: { ...config.linear, apiKeyEnv: workspace.apiKeyEnv, defaultApiKeyEnv: config.linear?.apiKeyEnv },
    statuses: { ...config.statuses, ...workspace.statuses },
    projects: config.projects.filter((project) => projectWorkspaceId(project) === workspaceId),
  }
}

export function validateWorkspaceProjects(config, previousConfig) {
  const workspaceIds = new Set(linearWorkspaces(config).map((workspace) => workspace.id))
  const previousProjects = new Map(previousConfig.projects.map((project) => [project.key, project]))
  const projects = new Map(config.projects.map((project) => [project.key, project]))
  const mappedTargets = new Set((config.linear.mappings || []).map((mapping) => mapping.targetProjectKey))
  for (const project of config.projects) {
    const previous = previousProjects.get(project.key)
    if (!workspaceIds.has(projectWorkspaceId(project))) {
      throw new Error(`${project.key}: Linear 工作区不存在。`)
    }
    if (previous && projectWorkspaceId(previous) !== projectWorkspaceId(project)) {
      throw new Error(`${project.key}: 项目所属工作区不能更改，请在目标工作区新建项目。`)
    }
    if (mappedTargets.has(project.key) && previous?.linearProjectId !== project.linearProjectId) {
      throw new Error(`${project.key}: 请先删除以该项目为目标的迁移映射。`)
    }
    if (typeof project.issueScope !== "string" || project.issueScope.length > 4000) {
      throw new Error(`${project.key}: 事项筛选条件必须是 4000 字以内的文本。`)
    }
  }
  for (const key of mappedTargets) {
    if (!projects.has(key)) throw new Error(`${key}: 请先删除以该项目为目标的迁移映射。`)
  }
}
