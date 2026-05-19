import { runCodex } from "./codex-runner.mjs"
import { createLinearClient } from "./linear-client.mjs"
import { buildPromptContext, readPrompt, renderPrompt } from "./prompts.mjs"

export function createScheduler({ rootDir, configProvider, store }) {
  let timer = null
  let enabled = false
  let running = false
  let nextRunAt = null
  let lastError = null
  const activeRunsByKey = new Map()
  const activeRunsById = new Map()
  const activeProjectCycles = new Map()

  async function logEvent(event) {
    await store.appendEvent(event).catch(() => {})
  }

  async function runOnce(stage = "both", options = {}) {
    const config = await configProvider()
    const linear = getLinear(config)
    const summary = {
      startedAt: new Date().toISOString(),
      stage,
      projectKey: options.projectKey || null,
      projects: [],
    }
    const projects = config.projects.filter(
      (project) => project.enabled && (!options.projectKey || project.key === options.projectKey),
    )
    await logEvent({
      type: "scan-start",
      stage,
      projectKey: options.projectKey,
      message: `开始扫描 ${projects.length} 个项目`,
      data: {
        enabledProjectCount: projects.length,
        issueId: options.issueId,
      },
    })

    summary.projects = await Promise.all(
      projects.map((project) =>
        runProjectCycle({ config, project, linear, stage, issueId: options.issueId }).catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error)
          await logEvent({
            type: "project-error",
            level: "error",
            stage,
            projectKey: project.key,
            message,
          })
          return {
            key: project.key,
            part1: [],
            part2: [],
            skipped: [],
            error: message,
          }
        }),
      ),
    )
    summary.finishedAt = new Date().toISOString()
    await logEvent({
      type: "scan-finish",
      stage,
      projectKey: options.projectKey,
      message: "扫描结束",
      data: {
        projectCount: summary.projects.length,
        finishedAt: summary.finishedAt,
      },
    })
    return summary
  }

  async function runProjectCycle({ config, project, linear, stage, issueId }) {
    const projectSummary = {
      key: project.key,
      part1: [],
      part2: [],
      skipped: [],
    }
    if (activeProjectCycles.has(project.key)) {
      projectSummary.skipped.push(`${project.key}: 项目正在执行`)
      await logEvent({
        type: "project-skip",
        stage,
        projectKey: project.key,
        message: "项目正在执行，本轮跳过",
      })
      return projectSummary
    }

    const controller = new AbortController()
    activeProjectCycles.set(project.key, {
      projectKey: project.key,
      startedAt: new Date().toISOString(),
      controller,
    })

    try {
      await logEvent({
        type: "project-start",
        stage,
        projectKey: project.key,
        message: "项目扫描开始",
        data: { issueId },
      })
      if (stage === "part1" || stage === "both") {
        await runProjectPart1({
          config,
          project,
          linear,
          projectSummary,
          issueId,
          signal: controller.signal,
        })
      }
      if (!controller.signal.aborted && (stage === "part2" || stage === "both")) {
        await runProjectPart2({
          config,
          project,
          linear,
          projectSummary,
          issueId,
          signal: controller.signal,
        })
      }
      if (controller.signal.aborted) {
        projectSummary.skipped.push(`${project.key}: 已停止当前项目执行`)
        await logEvent({
          type: "project-canceled",
          level: "warn",
          stage,
          projectKey: project.key,
          message: "项目本轮执行已停止",
        })
      }
      await logEvent({
        type: "project-finish",
        stage,
        projectKey: project.key,
        message: "项目扫描结束",
        data: {
          part1: projectSummary.part1.length,
          part2: projectSummary.part2.length,
          skipped: projectSummary.skipped.length,
        },
      })
      return projectSummary
    } finally {
      activeProjectCycles.delete(project.key)
    }
  }

  async function runProjectPart1({ config, project, linear, projectSummary, issueId, signal }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const eligibleStatuses = new Set([
      config.statuses.todo,
      config.statuses.needsClarification,
      config.statuses.blocked,
    ])
    const candidates = issueId
      ? issues.filter((issue) => issue.identifier === issueId || issue.id === issueId)
      : issues.filter((issue) => eligibleStatuses.has(issue.state?.name))

    await logEvent({
      type: "part1-candidates",
      stage: "part1",
      projectKey: project.key,
      message: `阶段一候选 ${candidates.length} 个`,
      data: {
        issueCount: issues.length,
        candidateCount: candidates.length,
        eligibleStatuses: [...eligibleStatuses],
        issueId,
      },
    })

    for (const issueRef of candidates.sort(compareIssuePriority)) {
      if (signal.aborted) {
        await logEvent({
          type: "part1-aborted",
          level: "warn",
          stage: "part1",
          projectKey: project.key,
          message: "阶段一项目信号已中止，停止处理后续候选",
        })
        break
      }

      const issue = await linear.getIssue(issueRef.identifier || issueRef.id)
      if (!issueId && !eligibleStatuses.has(issue.state?.name)) {
        projectSummary.skipped.push(`${issue.identifier}: 状态已不是阶段一队列状态`)
        await logEvent({
          type: "part1-skip-state-changed",
          stage: "part1",
          projectKey: project.key,
          issueIdentifier: issue.identifier,
          message: `${issue.identifier} 状态已不是阶段一队列状态，跳过`,
          data: { state: issue.state?.name },
        })
        continue
      }

      await logEvent({
        type: "run-queue",
        stage: "part1",
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `${issue.identifier} 进入阶段一执行`,
        data: { state: issue.state?.name },
      })
      const result = await executeCodexStage({ config, project, issue, stage: "part1", signal })
      projectSummary.part1.push({ issue: issue.identifier, result: result.status })
    }
  }

  async function runProjectPart2({ config, project, linear, projectSummary, issueId, signal }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const candidates = issueId
      ? issues.filter((issue) => issue.identifier === issueId || issue.id === issueId)
      : issues.filter((issue) => issue.state?.name === config.statuses.schedule)

    await logEvent({
      type: "part2-candidates",
      stage: "part2",
      projectKey: project.key,
      message: `阶段二候选 ${candidates.length} 个`,
      data: {
        issueCount: issues.length,
        candidateCount: candidates.length,
        activeCount: issues.filter((issue) => issue.state?.name === config.statuses.inProgress).length,
        maxActivePart2: project.maxActivePart2,
        issueId,
      },
    })

    for (const issueRef of candidates.sort(compareIssuePriority)) {
      if (signal.aborted) {
        await logEvent({
          type: "part2-aborted",
          level: "warn",
          stage: "part2",
          projectKey: project.key,
          message: "阶段二项目信号已中止，停止处理后续候选",
        })
        break
      }

      if (!issueId) {
        const active = await countActivePart2(linear, project, config)
        if (active >= project.maxActivePart2) {
          projectSummary.skipped.push(`${project.key}: 处理中数量已达上限`)
          await logEvent({
            type: "part2-skip-active-limit",
            stage: "part2",
            projectKey: project.key,
            message: "阶段二处理中数量已达上限",
            data: {
              activeCount: active,
              maxActivePart2: project.maxActivePart2,
            },
          })
          break
        }
      }

      const issue = await linear.getIssue(issueRef.identifier || issueRef.id)
      if (!issueId && issue.state?.name !== config.statuses.schedule) {
        projectSummary.skipped.push(`${issue.identifier}: 状态已不是 ${config.statuses.schedule}`)
        await logEvent({
          type: "part2-skip-state-changed",
          stage: "part2",
          projectKey: project.key,
          issueIdentifier: issue.identifier,
          message: `${issue.identifier} 状态已不是 ${config.statuses.schedule}，跳过`,
          data: { state: issue.state?.name },
        })
        continue
      }

      await logEvent({
        type: "run-queue",
        stage: "part2",
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `${issue.identifier} 进入阶段二执行`,
        data: { state: issue.state?.name },
      })
      const result = await executeCodexStage({ config, project, issue, stage: "part2", signal })
      projectSummary.part2.push({ issue: issue.identifier, result: result.status })
    }
  }

  async function executeCodexStage({ config, project, issue, stage, signal }) {
    const key = `${project.key}:${stage}:${issue.identifier}`
    if (activeRunsByKey.has(key)) {
      await logEvent({
        type: "run-skip-active",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `${issue.identifier} 已在执行中`,
      })
      return { status: "already-running" }
    }

    const runController = new AbortController()
    const abortFromProject = () => abortRun(runController, abortReason(signal, "用户中止项目任务"))
    if (signal.aborted) {
      abortFromProject()
    } else {
      signal.addEventListener("abort", abortFromProject, { once: true })
    }

    let run = await store.createRun({ projectKey: project.key, stage, issue })
    await logEvent({
      type: "run-start",
      stage,
      projectKey: project.key,
      issueIdentifier: issue.identifier,
      runId: run.id,
      message: `${issue.identifier} ${stageLabel(stage)} 开始`,
      data: { runDir: run.dir },
    })
    const active = {
      runId: run.id,
      projectKey: project.key,
      stage,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      },
      startedAt: new Date().toISOString(),
      pid: null,
      cancel: (reason = "用户中止任务") => abortRun(runController, reason),
    }
    activeRunsByKey.set(key, active)
    activeRunsById.set(run.id, active)

    try {
      if (runController.signal.aborted) {
        return await markRunCanceled(run, runController.signal)
      }

      const prompt = await buildStagePrompt({ config, project, issue, stage })
      const codexResult = await runCodex({
        config,
        project,
        stage,
        run,
        prompt,
        store,
        signal: runController.signal,
        onChild: (child) => {
          active.pid = child.pid || null
          void logEvent({
            type: "run-child",
            stage,
            projectKey: project.key,
            issueIdentifier: issue.identifier,
            runId: run.id,
            message: `${issue.identifier} Codex 子进程已启动`,
            data: { pid: active.pid },
          })
        },
      })

      if (codexResult.canceled || runController.signal.aborted) {
        return await markRunCanceled(run, runController.signal, {
          exitCode: codexResult.exitCode,
          pid: active.pid,
        })
      }

      const succeeded = codexResult.exitCode === 0
      run = await store.updateRun(run, {
        status: succeeded ? "succeeded" : "failed",
        exitCode: codexResult.exitCode,
        pid: active.pid,
        error: succeeded ? undefined : `Codex 退出码为 ${codexResult.exitCode}`,
      })
      await logEvent({
        type: succeeded ? "run-succeeded" : "run-failed",
        level: succeeded ? "info" : "error",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: `${issue.identifier} ${stageLabel(stage)} ${succeeded ? "成功" : "失败"}`,
        data: { exitCode: codexResult.exitCode, runDir: run.dir },
      })
      return run
    } catch (error) {
      if (runController.signal.aborted) {
        return await markRunCanceled(run, runController.signal, { pid: active.pid })
      }
      run = await store.updateRun(run, {
        status: "failed",
        pid: active.pid,
        error: error instanceof Error ? error.message : String(error),
      })
      await logEvent({
        type: "run-error",
        level: "error",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: error instanceof Error ? error.message : String(error),
        data: { runDir: run.dir },
      })
      throw error
    } finally {
      signal.removeEventListener("abort", abortFromProject)
      activeRunsByKey.delete(key)
      activeRunsById.delete(run.id)
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
- Linear 内部 ID: ${issue.id}
- 标题: ${issue.title}
- URL: ${issue.url}
- 当前状态: ${issue.state?.name || "未知"}
- 团队: ${issue.team?.key || issue.team?.name || "未知"} (${issue.team?.id || "未知"})
- 项目: ${issue.project?.name || "未知"}
- 优先级: ${issue.priorityLabel || issue.priority || "无"}
- 更新时间: ${issue.updatedAt || "未知"}

服务职责说明:
- 本地服务只负责发现队列并启动当前 Codex 进程。
- Linear 评论、状态移动、标签、阻塞关系和完成交接都由当前 Codex agent 直接操作。
- 运行结束前，请在最终回复里用简体中文说明你对 Linear 做了哪些操作；如果因为已有新鲜标记而跳过，也要说明跳过原因。

描述:
${issue.description || "（空）"}

最近评论:
${(issue.comments || [])
  .slice(-20)
  .map((comment) => `---\n${comment.createdAt} ${comment.user?.name || "未知用户"}:\n${comment.body}`)
  .join("\n")}
`
  }

  function start() {
    if (enabled) {
      return
    }
    enabled = true
    void logEvent({
      type: "daemon-start",
      message: "轮询已启动",
    })
    const loop = async () => {
      timer = null
      if (!enabled) {
        return
      }
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
      if (!enabled) {
        return
      }
      const config = await configProvider()
      nextRunAt = new Date(Date.now() + config.pollIntervalSeconds * 1000).toISOString()
      timer = setTimeout(loop, config.pollIntervalSeconds * 1000)
    }
    nextRunAt = new Date().toISOString()
    timer = setTimeout(loop, 0)
  }

  function stop() {
    enabled = false
    void logEvent({
      type: "daemon-stop",
      message: "轮询已停止",
    })
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    nextRunAt = null
  }

  function cancelRun(runId, reason = "用户中止任务") {
    const active = activeRunsById.get(runId)
    if (!active) {
      return { ok: false, error: "未找到正在运行的任务" }
    }
    active.cancel(reason)
    void logEvent({
      type: "cancel-run",
      level: "warn",
      projectKey: active.projectKey,
      stage: active.stage,
      issueIdentifier: active.issue.identifier,
      runId: active.runId,
      message: reason,
    })
    return { ok: true, runId }
  }

  function cancelProject(projectKey, reason = "用户中止项目任务") {
    let canceled = false
    const cycle = activeProjectCycles.get(projectKey)
    if (cycle && !cycle.controller.signal.aborted) {
      cycle.controller.abort(reason)
      canceled = true
    }
    for (const active of activeRunsById.values()) {
      if (active.projectKey === projectKey) {
        active.cancel(reason)
        canceled = true
      }
    }
    if (!canceled) {
      return { ok: false, error: "当前项目没有正在运行的任务" }
    }
    void logEvent({
      type: "cancel-project",
      level: "warn",
      projectKey,
      message: reason,
    })
    return { ok: true, projectKey }
  }

  function status() {
    return {
      running,
      enabled,
      nextRunAt,
      lastError,
      activeRuns: [...activeRunsById.values()].map((active) => ({
        runId: active.runId,
        projectKey: active.projectKey,
        stage: active.stage,
        startedAt: active.startedAt,
        pid: active.pid,
        issue: active.issue,
      })),
    }
  }

  return {
    runOnce,
    start,
    stop,
    status,
    cancelRun,
    cancelProject,
  }

  async function markRunCanceled(run, signal, patch = {}) {
    const next = await store.updateRun(run, {
      status: "canceled",
      exitCode: patch.exitCode,
      pid: patch.pid,
      canceledAt: new Date().toISOString(),
      cancelReason: abortReason(signal, "用户中止任务"),
    })
    await logEvent({
      type: "run-canceled",
      level: "warn",
      stage: run.stage,
      projectKey: run.projectKey,
      issueIdentifier: run.issueIdentifier,
      runId: run.id,
      message: next.cancelReason,
      data: { runDir: run.dir },
    })
    return next
  }
}

async function countActivePart2(linear, project, config) {
  const { issues } = await linear.listProjectIssues(project.linearProjectId)
  return issues.filter((issue) => issue.state?.name === config.statuses.inProgress).length
}

function getLinear(config) {
  const apiKeyEnv = config.linear?.apiKeyEnv || "LINEAR_API_KEY"
  const apiKey = process.env[apiKeyEnv]
  if (!apiKey) {
    throw new Error(`未设置 ${apiKeyEnv}。`)
  }
  return createLinearClient(apiKey)
}

function abortRun(controller, reason) {
  if (!controller.signal.aborted) {
    controller.abort(reason)
  }
}

function abortReason(signal, fallback) {
  if (!signal?.reason) {
    return fallback
  }
  return typeof signal.reason === "string" ? signal.reason : fallback
}

function compareIssuePriority(a, b) {
  const priorityDiff = Number(b.priority || 0) - Number(a.priority || 0)
  if (priorityDiff !== 0) {
    return priorityDiff
  }
  return String(a.updatedAt).localeCompare(String(b.updatedAt))
}

function stageLabel(stage) {
  if (stage === "part1") return "阶段一"
  if (stage === "part2") return "阶段二"
  return stage
}
