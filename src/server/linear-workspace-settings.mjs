import { randomUUID } from "node:crypto"
import { writeLocalEnvValue } from "./env.mjs"
import { activeWorkspaceId, DEFAULT_WORKSPACE_ID, linearWorkspaces, projectWorkspaceId } from "./linear-workspaces.mjs"

export async function bindWorkspace(config, body, { rootDir, createClient }) {
  const { mode } = body
  validateMode(mode)
  const key = typeof body.linearApiKey === "string" ? body.linearApiKey.trim() : ""
  if (!key || /[\r\n\0]/u.test(key)) throw new Error("请填写有效的 Linear API key。")
  const primaryKey = process.env[config.linear.apiKeyEnv]
  if (!primaryKey) throw new Error("请先配置默认工作区的 Linear API key。")
  const [primary, workspace] = await Promise.all([
    config.linear.defaultWorkspace?.organizationId
      ? { id: config.linear.defaultWorkspace.organizationId, name: config.linear.defaultWorkspace.name }
      : createClient(primaryKey).readOrganization(),
    createClient(key).readOrganization(),
  ])
  if (workspace.id === primary.id || config.linear.workspaces?.some((item) => item.id === workspace.id)) {
    throw new Error("该 Linear 工作区已绑定。")
  }
  if (!uuidPattern.test(workspace.id)) throw new Error("Linear 返回了无效的工作区 ID。")
  const apiKeyEnv = `LINEAR_API_KEY_WORKSPACE_${workspace.id.toUpperCase().replaceAll("-", "_")}`
  await writeLocalEnvValue(rootDir, apiKeyEnv, key)
  process.env[apiKeyEnv] = key
  return { ...config, linear: {
    ...config.linear,
    defaultWorkspace: { ...config.linear.defaultWorkspace, name: primary.name, organizationId: primary.id },
    workspaces: [...(config.linear.workspaces || []), {
      id: workspace.id, name: workspace.name, mode, apiKeyEnv, inactiveSince: new Date().toISOString(),
    }],
  } }
}

export function updateWorkspace(config, id, body) {
  const workspace = requireWorkspace(config, id)
  let linear = { ...config.linear }
  const now = new Date().toISOString()
  const previousId = activeWorkspaceId(config)
  if (body.activate === true && id !== previousId) {
    if (!process.env[workspace.apiKeyEnv]) throw new Error("该工作区的 Linear API key 未设置。")
    linear = patchWorkspace(linear, previousId, { inactiveSince: now })
    linear.activeWorkspaceId = id
    linear.workspaceActivatedAt = now
  }
  if (body.mode !== undefined) {
    validateMode(body.mode)
    if (workspace.mode !== body.mode) {
      linear = patchWorkspace(linear, id, { mode: body.mode, inactiveSince: now })
    }
  }
  return { ...config, linear }
}

export async function addWorkspaceMapping(config, body, createClient) {
  const source = requireWorkspace(config, body.sourceWorkspaceId)
  const targetProject = config.projects.find((project) => project.key === body.targetProjectKey)
  if (!targetProject || source.id === projectWorkspaceId(targetProject)) {
    throw new Error("请选择另一工作区内已配置的 WA 项目作为目标。")
  }
  const target = requireWorkspace(config, projectWorkspaceId(targetProject))
  const mappings = config.linear.mappings || []
  if (mappings.some((mapping) => mapping.sourceWorkspaceId === source.id &&
    mapping.sourceProjectId === body.sourceProjectId && mapping.targetWorkspaceId === target.id)) {
    throw new Error("该来源项目在此目标工作区中已有映射。")
  }
  const [sourceProject, destination] = await Promise.all([
    workspaceClient(source, createClient).readProject(body.sourceProjectId),
    workspaceClient(target, createClient).readProject(targetProject.linearProjectId),
  ])
  const team = destination.teams.find((item) => item.id === body.targetTeamId && !item.archivedAt)
  if (!team) throw new Error("请选择目标 Linear 项目下的团队。")
  const mapping = {
    id: randomUUID(), since: new Date().toISOString(), sourceWorkspaceId: source.id,
    sourceProjectId: sourceProject.id, sourceProjectName: sourceProject.name,
    targetWorkspaceId: target.id, targetProjectKey: targetProject.key, targetTeamId: team.id, targetTeamName: team.name,
  }
  return { ...config, linear: { ...config.linear, mappings: [...mappings, mapping] } }
}

export function applyGeneralSettings(current, body) {
  const workspaceId = activeWorkspaceId(current)
  if (body.linear?.activeWorkspaceId && body.linear.activeWorkspaceId !== workspaceId) {
    throw new Error("激活的工作区已更改，请刷新页面后再保存。")
  }
  const apiKeyEnv = body.linear?.apiKeyEnv ?? current.linear.apiKeyEnv
  let linear = { ...current.linear, apiKeyEnv }
  let statuses = body.statuses ?? current.statuses
  if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    linear = patchWorkspace(linear, workspaceId, { statuses })
    statuses = current.statuses
  }
  return { ...body, linear, statuses }
}

export function requireWorkspace(config, id) {
  const workspace = linearWorkspaces(config).find((item) => item.id === id)
  if (!workspace) throw new Error("Linear 工作区不存在。")
  return workspace
}

export function workspaceClient(workspace, createClient) {
  const key = process.env[workspace.apiKeyEnv]
  if (!key) throw new Error(`工作区「${workspace.name}」的 Linear API key 未设置。`)
  return createClient(key)
}

function patchWorkspace(linear, id, patch) {
  if (id === DEFAULT_WORKSPACE_ID) {
    return { ...linear, defaultWorkspace: { ...linear.defaultWorkspace, ...patch } }
  }
  return { ...linear, workspaces: linear.workspaces.map((workspace) =>
    workspace.id === id ? { ...workspace, ...patch } : workspace) }
}

function validateMode(mode) {
  if (!["isolated", "migrated"].includes(mode)) throw new Error("请选择 isolated 或 migrated。")
}

const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu
