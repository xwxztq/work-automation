import path from "node:path"
import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { readJsonFile } from "./config.mjs"
import { STATE_DIR } from "./defaults.mjs"
import { activeWorkspaceId, linearWorkspaces } from "./linear-workspaces.mjs"
import { recordIssueAudit, withIssueAuditContext } from "./issue-audit.mjs"

export async function migrateLinearIssues({ rootDir, config, projects, linear, sourceClient, isCurrent, store }) {
  const directory = migrationDirectory(rootDir)
  const targets = new Map(projects.map((project) => [project.key, project]))
  const activeId = activeWorkspaceId(config)
  const sources = new Map(linearWorkspaces(config)
    .filter((workspace) => workspace.id !== activeId && workspace.mode === "migrated" && workspace.inactiveSince)
    .map((workspace) => [workspace.id, workspace]))
  const clients = new Map()
  const report = (event) => store.appendEvent({ stage: "migration", ...event })
  let pending = null

  for (const mapping of config.linear?.mappings || []) {
    const project = targets.get(mapping.targetProjectKey)
    const source = sources.get(mapping.sourceWorkspaceId)
    if (!source || !project || !await isCurrent(mapping)) continue
    await withIssueAuditContext({ stage: "migration", projectKey: project.key }, async () => {
      try {
        pending ||= await readPending(directory)
        if (!clients.has(source.id)) clients.set(source.id, sourceClient(source.id))
        const client = clients.get(source.id)
        if (!client) throw new Error(`工作区「${source.name}」的 Linear API key 未设置。`)
        const cursorPath = path.join(directory, `mapping-${hash(mapping.id)}.json`)
        const cursor = await readJsonFile(cursorPath, null)
        const from = Math.max(Date.parse(mapping.since), Date.parse(source.inactiveSince),
          (Date.parse(cursor?.through) || 0) - 60_000)
        const through = new Date().toISOString()
        const issues = await client.listNewProjectIssues(mapping.sourceProjectId, new Date(from).toISOString())
        const candidates = new Map(issues.filter((issue) => Date.parse(issue.createdAt) >= from).map((issue) => [issue.id, issue]))
        for (const entry of pending) {
          if (entry.sourceWorkspaceId === source.id && entry.sourceProjectId === mapping.sourceProjectId &&
            entry.workspaceId === activeId && entry.projectId === project.linearProjectId &&
            entry.teamId === mapping.targetTeamId && !candidates.has(entry.sourceIssueId)) {
            candidates.set(entry.sourceIssueId, { id: entry.sourceIssueId, identifier: entry.sourceIdentifier, url: entry.sourceUrl })
          }
        }
        let complete = true
        for (const issue of candidates.values()) {
          if (!await isCurrent(mapping)) return
          try {
            const migrated = await migrateIssue({ directory, source, project, mapping, issue, client, linear, config, store, isCurrent })
            if (!migrated) continue
            await report({ type: "issue-migrated", projectKey: project.key, issueIdentifier: migrated.identifier,
              message: `${source.name} / ${issue.identifier} → ${migrated.identifier}` })
          } catch (error) {
            complete = false
            await report({ type: "issue-migration-error", level: "error", projectKey: project.key,
              issueIdentifier: issue.identifier, message: error.message })
          }
        }
        if (complete && await isCurrent(mapping)) await writeRecord(cursorPath, { through })
      } catch (error) {
        await report({ type: "project-migration-error", level: "error", projectKey: project.key, message: error.message })
      }
    })
  }
}

async function migrateIssue({ directory, source, project, mapping, issue, client, linear, config, store, isCurrent }) {
  if (await readJsonFile(copyMarker(directory, issue.id), null)) return null
  const key = sourceKey(source, issue.id)
  const completed = path.join(directory, "completed", `${key}.json`)
  const pending = path.join(directory, "pending", `${key}.json`)
  if (await readJsonFile(completed, null)) return null
  const target = { workspaceId: activeWorkspaceId(config), projectId: project.linearProjectId, teamId: mapping.targetTeamId }
  const existing = await readJsonFile(pending, null)
  const record = existing || { ...target, id: randomUUID(), sourceWorkspaceId: source.id, sourceProjectId: mapping.sourceProjectId, sourceIssueId: issue.id,
    sourceIdentifier: issue.identifier, sourceUrl: issue.url }
  if (Object.keys(target).some((field) => target[field] !== record[field])) {
    throw new Error("该事项已有另一目标的迁移记录，请在原目标核对迁移结果。")
  }
  const { id } = record
  const sourceLine = `来源事项：${record.sourceUrl || `Linear ${record.sourceIdentifier || issue.id}`}`
  let migrated = existing ? await findMigratedIssue(linear, id) : null
  if (!migrated) {
    if (!issue.title) {
      issue = await client.readIssue(issue.id)
      if (issue.project?.id !== mapping.sourceProjectId) throw new Error("待迁移事项的来源项目已变更。")
    }
    const states = await linear.listTeamWorkflowStates(target.teamId)
    const todo = states.filter((state) => !state.archivedAt && state.name === config.statuses.todo &&
      !["completed", "canceled"].includes(state.type))
    if (todo.length !== 1) throw new Error(`目标团队需要唯一的「${config.statuses.todo}」队列状态。`)
    if (!await isCurrent(mapping)) return null
    if (!existing) {
      if (!await writeRecord(pending, record, { exclusive: true })) return null
      if (await readJsonFile(completed, null)) {
        await fs.rm(pending, { force: true })
        return null
      }
    }
    await writeRecord(copyMarker(directory, id), { copied: true })
    if (!await isCurrent(mapping)) return null
    try {
      await withIssueAuditContext({ issueId: issue.id, projectId: target.projectId, idempotencyKey: id }, () =>
        linear.operationWriter.createMigratedIssue({
          id, teamId: target.teamId, projectId: target.projectId, stateId: todo[0].id,
          title: issue.title,
          description: issue.description ? `${issue.description}\n\n---\n\n${sourceLine}` : sourceLine,
          priority: issue.priority ?? 0,
        }))
    } catch (error) {
      migrated = await findMigratedIssue(linear, id).catch(() => null)
      if (!migrated) throw error
    }
    migrated ||= await findMigratedIssue(linear, id)
  }
  if (migrated?.id !== id || migrated.project?.id !== target.projectId || migrated.team?.id !== target.teamId ||
    !migrated.description?.includes(sourceLine)) {
    throw new Error("Linear 迁移事项回读未能确认目标项目、团队与来源。")
  }
  await writeRecord(completed, { ...target, id, identifier: migrated.identifier })
  await fs.rm(pending, { force: true })
  await recordIssueAudit(store, { operation: "issue.migration.create", result: "verified", issueId: issue.id,
    projectId: target.projectId, resourceId: id, idempotencyKey: id })
  return migrated
}

export async function readIssueMigration(rootDir, workspace, issueId) {
  const directory = migrationDirectory(rootDir)
  const file = `${sourceKey(workspace, issueId)}.json`
  return await readJsonFile(path.join(directory, "completed", file), null) ||
    await readJsonFile(path.join(directory, "pending", file), null)
}

function migrationDirectory(rootDir) {
  return path.join(rootDir, STATE_DIR, "linear-migrations")
}

function copyMarker(directory, issueId) {
  return path.join(directory, "copies", `${hash(issueId)}.json`)
}

function sourceKey(workspace, issueId) {
  return hash(JSON.stringify([workspace.organizationId || workspace.id, issueId]))
}

async function readPending(directory) {
  const dir = path.join(directory, "pending")
  const files = await fs.readdir(dir).catch((error) => {
    if (error.code !== "ENOENT") throw error
    return []
  })
  return (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) =>
    readJsonFile(path.join(dir, file), null)))).filter(Boolean)
}

// Publish complete JSON atomically and reserve a source issue once across the
// scheduler and separate `once` processes.
async function writeRecord(file, value, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(value))
    if (exclusive) await fs.link(temp, file)
    else await fs.rename(temp, file)
    return true
  } catch (error) {
    if (exclusive && error.code === "EEXIST") return false
    throw error
  } finally {
    await fs.rm(temp, { force: true })
  }
}

async function findMigratedIssue(linear, id) {
  try {
    return await linear.readIssue(id)
  } catch (error) {
    if (error.code !== "NOT_FOUND") throw error
    return null
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex")
}
