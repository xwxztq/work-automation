import {
  hasRecentMarker,
  renderHandoffComment,
  renderPart1Comment,
  renderPart2Comment,
} from "./comments.mjs"
import { runCodex } from "./codex-runner.mjs"
import { createLinearClient } from "./linear-client.mjs"
import { buildPromptContext, readPrompt, renderPrompt } from "./prompts.mjs"

const PART1_MARKERS = [
  "AI Triage: READY",
  "AI Triage: NEEDS CLARIFICATION",
  "AI Triage: TOO LARGE",
  "AI Triage: BLOCKED",
  "AI Triage: DUPLICATE OR RELATED",
]

export function createScheduler({ rootDir, configProvider, store }) {
  let timer = null
  let running = false
  let nextRunAt = null
  let lastError = null
  const activeRuns = new Map()

  async function runOnce(stage = "both", options = {}) {
    const config = await configProvider()
    const linear = getLinear(config)
    const summary = {
      startedAt: new Date().toISOString(),
      stage,
      projects: [],
    }

    for (const project of config.projects.filter((item) => item.enabled)) {
      const projectSummary = {
        key: project.key,
        part1: [],
        part2: [],
        skipped: [],
      }
      summary.projects.push(projectSummary)
      if (stage === "part1" || stage === "both") {
        await runProjectPart1({ config, project, linear, projectSummary, issueId: options.issueId })
      }
      if (stage === "part2" || stage === "both") {
        await runProjectPart2({ config, project, linear, projectSummary, issueId: options.issueId })
      }
    }

    summary.finishedAt = new Date().toISOString()
    return summary
  }

  async function runProjectPart1({ config, project, linear, projectSummary, issueId }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const eligibleStatuses = new Set([
      config.statuses.todo,
      config.statuses.needsClarification,
      config.statuses.blocked,
    ])
    const candidates = issueId
      ? issues.filter((issue) => issue.identifier === issueId || issue.id === issueId)
      : issues.filter((issue) => eligibleStatuses.has(issue.state?.name))

    for (const issueRef of candidates) {
      const issue = await linear.getIssue(issueRef.identifier || issueRef.id)
      if (!issueId && hasRecentMarker(issue, PART1_MARKERS)) {
        projectSummary.skipped.push(`${issue.identifier}: 已有最新分析标记`)
        continue
      }
      const result = await executeCodexStage({ config, project, linear, issue, stage: "part1" })
      projectSummary.part1.push({ issue: issue.identifier, result: result.finalJson?.result || result.status })
    }
  }

  async function runProjectPart2({ config, project, linear, projectSummary, issueId }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const active = issues.filter((issue) => issue.state?.name === config.statuses.inProgress)
    if (!issueId && active.length >= project.maxActivePart2) {
      projectSummary.skipped.push(`${project.key}: 处理中数量已达上限`)
      return
    }
    const candidates = issueId
      ? issues.filter((issue) => issue.identifier === issueId || issue.id === issueId)
      : issues.filter((issue) => issue.state?.name === config.statuses.schedule)

    const [candidate] = candidates.sort(compareIssuePriority)
    if (!candidate) {
      return
    }
    const issue = await linear.getIssue(candidate.identifier || candidate.id)
    if (issue.state?.name !== config.statuses.schedule && !issueId) {
      return
    }
    const result = await executeCodexStage({ config, project, linear, issue, stage: "part2" })
    projectSummary.part2.push({ issue: issue.identifier, result: result.finalJson?.result || result.status })
  }

  async function executeCodexStage({ config, project, linear, issue, stage }) {
    const key = `${project.key}:${stage}:${issue.identifier}`
    if (activeRuns.has(key)) {
      return { status: "already-running" }
    }
    activeRuns.set(key, { issue, stage, startedAt: new Date().toISOString() })
    let run = await store.createRun({ projectKey: project.key, stage, issue })

    try {
      if (stage === "part2") {
        await linear.updateIssueState(issue, config.statuses.inProgress)
        await linear.createComment(issue, renderHandoffComment(issue, project, config.statuses))
      }

      const prompt = await buildStagePrompt({ config, project, issue, stage })
      const codexResult = await runCodex({ config, project, stage, run, prompt, store })
      const finalJson = codexResult.finalJson
      if (codexResult.exitCode !== 0 || !finalJson) {
        const fallback = {
          result: stage === "part1" ? "BLOCKED" : "FAILED",
          summary: [`Codex 退出码为 ${codexResult.exitCode}，或最终输出不是 JSON。`],
          blockerOrQuestions: [`查看 run 日志: ${run.dir}`],
          blockedReason: [`查看 run 日志: ${run.dir}`],
        }
        await applyLinearResult({ config, linear, issue, stage, finalJson: fallback })
        run = await store.updateRun(run, {
          status: "failed",
          exitCode: codexResult.exitCode,
          finalJson: fallback,
        })
        return run
      }
      await applyLinearResult({ config, linear, issue, stage, finalJson })
      run = await store.updateRun(run, {
        status: "succeeded",
        exitCode: codexResult.exitCode,
        finalJson,
      })
      return run
    } catch (error) {
      run = await store.updateRun(run, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      activeRuns.delete(key)
    }
  }

  async function buildStagePrompt({ config, project, issue, stage }) {
    const scope =
      stage === "part1"
        ? project.part1PromptMode === "override"
          ? project.key
          : "global"
        : project.part2PromptMode === "override"
          ? project.key
          : "global"
    const template = await readPrompt(rootDir, scope, stage)
    const context = buildPromptContext(config, project)
    return `${renderPrompt(template, context)}

当前 Linear 事项:
- ID: ${issue.identifier}
- 标题: ${issue.title}
- URL: ${issue.url}
- 当前状态: ${issue.state?.name || "未知"}
- 优先级: ${issue.priorityLabel || issue.priority || "无"}

描述:
${issue.description || "（空）"}

最近评论:
${(issue.comments || [])
  .slice(-20)
  .map((comment) => `---\n${comment.createdAt} ${comment.user?.name || "未知用户"}:\n${comment.body}`)
  .join("\n")}
`
  }

  async function applyLinearResult({ config, linear, issue, stage, finalJson }) {
    if (stage === "part1") {
      const comment = renderPart1Comment(finalJson, config.statuses)
      await linear.createComment(issue, comment)
      if (finalJson.result === "READY") {
        await linear.updateIssueState(issue, config.statuses.ready)
      } else if (finalJson.result === "BLOCKED") {
        await linear.updateIssueState(issue, config.statuses.blocked)
      } else if (finalJson.result === "NEEDS_CLARIFICATION" || finalJson.result === "TOO_LARGE") {
        await linear.updateIssueState(issue, config.statuses.needsClarification)
      }
      return
    }

    const comment = renderPart2Comment(finalJson, config.statuses)
    if (finalJson.result === "COMPLETE") {
      await linear.updateIssueState(issue, config.statuses.testing)
    } else if (finalJson.result === "NEEDS_CLARIFICATION") {
      await linear.updateIssueState(issue, config.statuses.needsClarification)
    } else {
      await linear.updateIssueState(issue, config.statuses.blocked)
    }
    await linear.createComment(issue, comment)
  }

  function start() {
    if (timer) {
      return
    }
    const loop = async () => {
      if (!running) {
        running = true
        try {
          await runOnce("both")
          lastError = null
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
        } finally {
          running = false
        }
      }
      const config = await configProvider()
      nextRunAt = new Date(Date.now() + config.pollIntervalSeconds * 1000).toISOString()
      timer = setTimeout(loop, config.pollIntervalSeconds * 1000)
    }
    nextRunAt = new Date().toISOString()
    timer = setTimeout(loop, 0)
  }

  function stop() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    nextRunAt = null
  }

  function status() {
    return {
      running,
      enabled: Boolean(timer),
      nextRunAt,
      lastError,
      activeRuns: [...activeRuns.values()],
    }
  }

  return {
    runOnce,
    start,
    stop,
    status,
  }
}

function getLinear(config) {
  const apiKeyEnv = config.linear?.apiKeyEnv || "LINEAR_API_KEY"
  const apiKey = process.env[apiKeyEnv]
  if (!apiKey) {
    throw new Error(`未设置 ${apiKeyEnv}。`)
  }
  return createLinearClient(apiKey)
}

function compareIssuePriority(a, b) {
  const priorityDiff = Number(b.priority || 0) - Number(a.priority || 0)
  if (priorityDiff !== 0) {
    return priorityDiff
  }
  return String(a.updatedAt).localeCompare(String(b.updatedAt))
}
