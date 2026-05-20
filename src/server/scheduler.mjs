import { createHash } from "node:crypto"
import { runCodex } from "./codex-runner.mjs"
import { createLinearClient } from "./linear-client.mjs"
import { buildPromptContext, readPrompt, renderPrompt } from "./prompts.mjs"

export function createScheduler({ rootDir, configProvider, store }) {
  let timer = null
  let enabled = false
  let running = false
  let activeDaemonScans = 0
  let nextRunAt = null
  let lastError = null
  const activeRunsByKey = new Map()
  const activeRunsById = new Map()
  const activeProjectCycles = new Set()

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
    const controller = new AbortController()
    const cycle = {
      projectKey: project.key,
      stage,
      startedAt: new Date().toISOString(),
      controller,
    }
    activeProjectCycles.add(cycle)

    try {
      await logEvent({
        type: "project-start",
        stage,
        projectKey: project.key,
        message: "项目扫描开始",
        data: { issueId },
      })
      const effectiveStage =
        issueId && stage === "both"
          ? await resolveManualIssueStage({ config, project, linear, projectSummary, issueId })
          : stage
      if (!effectiveStage) {
        return projectSummary
      }
      if (effectiveStage === "both") {
        await Promise.all([
          runProjectStageBranch({
            project,
            stage: "part1",
            projectSummary,
            run: () =>
              runProjectPart1({
                config,
                project,
                linear,
                projectSummary,
                issueId,
                signal: controller.signal,
              }),
          }),
          runProjectStageBranch({
            project,
            stage: "part2",
            projectSummary,
            run: () =>
              runProjectPart2({
                config,
                project,
                linear,
                projectSummary,
                issueId,
                signal: controller.signal,
              }),
          }),
        ])
      } else if (effectiveStage === "part1") {
        await runProjectPart1({
          config,
          project,
          linear,
          projectSummary,
          issueId,
          signal: controller.signal,
        })
      } else if (!controller.signal.aborted && effectiveStage === "part2") {
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
      activeProjectCycles.delete(cycle)
    }
  }

  async function runProjectStageBranch({ project, stage, projectSummary, run }) {
    try {
      await run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      projectSummary.skipped.push(`${project.key}: ${stageLabel(stage)}执行失败: ${message}`)
      await logEvent({
        type: `${stage}-error`,
        level: "error",
        stage,
        projectKey: project.key,
        message,
      })
    }
  }

  async function resolveManualIssueStage({ config, project, linear, projectSummary, issueId }) {
    let issue
    try {
      issue = await linear.getIssue(issueId)
    } catch (error) {
      projectSummary.skipped.push(`${issueId}: 未找到手动指定 issue`)
      await logEvent({
        type: "manual-issue-not-found",
        level: "warn",
        stage: "both",
        projectKey: project.key,
        message: `未找到手动指定 issue: ${issueId}`,
        data: {
          issueId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }

    let linearProject
    try {
      ;({ project: linearProject } = await linear.listProjectIssues(project.linearProjectId, 1))
    } catch (error) {
      projectSummary.skipped.push(`${project.key}: 无法读取 Linear 项目`)
      await logEvent({
        type: "manual-issue-project-read-failed",
        level: "error",
        stage: "both",
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `无法读取手动 issue 对应的项目: ${project.key}`,
        data: {
          issueId,
          configuredProjectId: project.linearProjectId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }

    if (issue.project?.id !== linearProject.id) {
      projectSummary.skipped.push(`${issue.identifier}: 不属于当前项目`)
      await logEvent({
        type: "manual-issue-not-in-project",
        stage: "both",
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `手动指定 issue 不属于当前项目: ${issue.identifier}`,
        data: {
          issueId,
          issueProjectId: issue.project?.id || null,
          configuredProjectId: project.linearProjectId,
          projectId: linearProject.id,
        },
      })
      return null
    }

    const stateName = issue.state?.name
    const eligiblePart1Statuses = part1EligibleStatuses(config)
    let effectiveStage = null
    if (eligiblePart1Statuses.has(stateName)) {
      effectiveStage = "part1"
    } else if (stateName === config.statuses.schedule) {
      effectiveStage = "part2"
    }

    if (effectiveStage) {
      await logEvent({
        type: "manual-issue-routed",
        stage: "both",
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `${issue.identifier} 根据当前状态 ${stateName} 路由到${stageLabel(effectiveStage)}`,
        data: {
          issueId,
          state: stateName,
          effectiveStage,
        },
      })
      return effectiveStage
    }

    projectSummary.skipped.push(`${issue.identifier}: 手动指定 issue 当前状态不可执行`)
    await logEvent({
      type: "manual-issue-skip-state",
      stage: "both",
      projectKey: project.key,
      issueIdentifier: issue.identifier,
      message: `${issue.identifier} 当前状态 ${stateName || "未知"} 不属于手动执行可路由阶段，跳过`,
      data: {
        issueId,
        state: stateName,
        part1Statuses: [...eligiblePart1Statuses],
        part2Status: config.statuses.schedule,
      },
    })
    return null
  }

  async function runProjectPart1({ config, project, linear, projectSummary, issueId, signal }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const eligibleStatuses = part1EligibleStatuses(config)
    const candidates = issueId
      ? issues.filter((issue) => issueMatchesId(issue, issueId))
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

    const results = await Promise.all(
      candidates.sort(compareIssuePriority).map((issueRef) =>
        runProjectPart1Candidate({
          config,
          project,
          linear,
          projectSummary,
          eligibleStatuses,
          issueId,
          issueRef,
          signal,
        }),
      ),
    )
    projectSummary.part1.push(...results.filter(Boolean))
  }

  async function runProjectPart1Candidate({
    config,
    project,
    linear,
    projectSummary,
    eligibleStatuses,
    issueId,
    issueRef,
    signal,
  }) {
    const issueIdentifier = issueRef.identifier || issueRef.id
    if (signal.aborted) {
      await logEvent({
        type: "part1-aborted",
        level: "warn",
        stage: "part1",
        projectKey: project.key,
        issueIdentifier,
        message: "阶段一项目信号已中止，跳过候选",
      })
      return null
    }

    try {
      const issue = await linear.getIssue(issueIdentifier)
      if (!eligibleStatuses.has(issue.state?.name)) {
        projectSummary.skipped.push(`${issue.identifier}: 状态已不是阶段一队列状态`)
        await logEvent({
          type: "part1-skip-state-changed",
          stage: "part1",
          projectKey: project.key,
          issueIdentifier: issue.identifier,
          message: `${issue.identifier} 状态已不是阶段一队列状态，跳过`,
          data: { state: issue.state?.name },
        })
        return null
      }
      if (!issueId && (await skipUnchangedIssue({ project, issue, stage: "part1", projectSummary }))) {
        return null
      }
      if (signal.aborted) {
        await logEvent({
          type: "part1-aborted",
          level: "warn",
          stage: "part1",
          projectKey: project.key,
          issueIdentifier: issue.identifier,
          message: "阶段一项目信号已中止，跳过候选",
        })
        return null
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
      await recordProcessedIssue({ linear, project, issue, stage: "part1", run: result })
      return { issue: issue.identifier, result: result.status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await logEvent({
        type: "part1-candidate-error",
        level: "error",
        stage: "part1",
        projectKey: project.key,
        issueIdentifier,
        message,
      })
      return { issue: issueIdentifier, result: "failed" }
    }
  }

  async function runProjectPart2({ config, project, linear, projectSummary, issueId, signal }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const candidates = issueId
      ? issues.filter((issue) => issueMatchesId(issue, issueId))
      : issues.filter((issue) => issue.state?.name === config.statuses.schedule)
    const activeStats = activePart2StatsFromIssues(issues, project, config)

    await logEvent({
      type: "part2-candidates",
      stage: "part2",
      projectKey: project.key,
      message: `阶段二候选 ${candidates.length} 个`,
      data: {
        issueCount: issues.length,
        candidateCount: candidates.length,
        activeCount: activeStats.count,
        linearInProgressCount: activeStats.linearInProgressCount,
        localActivePart2Count: activeStats.localActivePart2Count,
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

      const issue = await linear.getIssue(issueRef.identifier || issueRef.id)
      if (issue.state?.name !== config.statuses.schedule) {
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
      const activeLimitStats = await countActivePart2(linear, project, config)
      if (activeLimitStats.count >= project.maxActivePart2) {
        projectSummary.skipped.push(`${project.key}: 处理中数量已达上限`)
        await logEvent({
          type: "part2-skip-active-limit",
          stage: "part2",
          projectKey: project.key,
          message: "阶段二处理中数量已达上限",
          data: {
            activeCount: activeLimitStats.count,
            linearInProgressCount: activeLimitStats.linearInProgressCount,
            localActivePart2Count: activeLimitStats.localActivePart2Count,
            maxActivePart2: project.maxActivePart2,
            issueId,
          },
        })
        break
      }
      if (!issueId && (await skipUnchangedIssue({ project, issue, stage: "part2", projectSummary }))) {
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
      const result = await executeCodexStage({
        config,
        project,
        issue,
        stage: "part2",
        signal,
        enforceLocalPart2Limit: true,
      })
      await recordProcessedIssue({ linear, project, issue, stage: "part2", run: result })
      projectSummary.part2.push({ issue: issue.identifier, result: result.status })
    }
  }

  async function countActivePart2(linear, project, config) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    return activePart2StatsFromIssues(issues, project, config)
  }

  function activePart2StatsFromIssues(issues, project, config) {
    const linearIssueKeys = new Set()
    for (const issue of issues) {
      if (issue.state?.name !== config.statuses.inProgress) {
        continue
      }
      const key = issueActiveKey(issue)
      if (key) {
        linearIssueKeys.add(key)
      }
    }

    const localIssueKeys = new Set()
    for (const active of activeLocalRuns()) {
      if (active.projectKey !== project.key || active.stage !== "part2") {
        continue
      }
      const key = issueActiveKey(active.issue)
      if (key) {
        localIssueKeys.add(key)
      }
    }

    return {
      count: new Set([...linearIssueKeys, ...localIssueKeys]).size,
      linearInProgressCount: linearIssueKeys.size,
      localActivePart2Count: localIssueKeys.size,
    }
  }

  function activeLocalRuns() {
    const seen = new Set()
    const active = []
    for (const item of activeRunsByKey.values()) {
      if (!seen.has(item)) {
        seen.add(item)
        active.push(item)
      }
    }
    for (const item of activeRunsById.values()) {
      if (!seen.has(item)) {
        seen.add(item)
        active.push(item)
      }
    }
    return active
  }

  function countLocalActivePart2(project) {
    const issueKeys = new Set()
    for (const active of activeLocalRuns()) {
      if (active.projectKey !== project.key || active.stage !== "part2") {
        continue
      }
      const key = issueActiveKey(active.issue)
      if (key) {
        issueKeys.add(key)
      }
    }
    return issueKeys.size
  }

  async function skipUnchangedIssue({ project, issue, stage, projectSummary }) {
    const fingerprint = issueFingerprint(issue)
    const processed = await store.getProcessedIssue(project.key, stage, issue.id)
    if (processed?.fingerprint !== fingerprint) {
      return false
    }
    const startupFailureRun = await getProcessedStartupFailureRun(processed)
    if (startupFailureRun) {
      await logEvent({
        type: "issue-retry-after-startup-failure",
        level: "warn",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: startupFailureRun.id,
        message: `${issue.identifier} 上次处理快照来自 Codex 启动失败，本轮继续重试`,
        data: {
          fingerprint,
          recordedAt: processed.recordedAt,
          issueUpdatedAt: issue.updatedAt,
          state: issue.state?.name,
          startupError: startupFailureRun.startupError || startupFailureRun.error || null,
        },
      })
      return false
    }
    projectSummary.skipped.push(`${issue.identifier}: 自上次处理后没有变化`)
    await logEvent({
      type: "issue-skip-unchanged",
      stage,
      projectKey: project.key,
      issueIdentifier: issue.identifier,
      message: `${issue.identifier} 自上次处理后没有变化，跳过`,
      data: {
        fingerprint,
        recordedAt: processed.recordedAt,
        issueUpdatedAt: issue.updatedAt,
        state: issue.state?.name,
      },
    })
    return true
  }

  async function recordProcessedIssue({ linear, project, issue, stage, run }) {
    if (!run?.id || run.status === "already-running" || run.status === "canceled") {
      return
    }
    if (isCodexStartupFailureRun(run)) {
      await logEvent({
        type: "issue-processed-not-recorded",
        level: "warn",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: `${issue.identifier} Codex 子进程未成功启动，未记录处理快照`,
        data: {
          runStatus: run.status,
          codexStarted: run.codexStarted,
          startupError: run.startupError || run.error || null,
        },
      })
      return
    }
    let latestIssue = issue
    try {
      latestIssue = await linear.getIssue(issue.identifier || issue.id)
    } catch (error) {
      await logEvent({
        type: "processed-refresh-failed",
        level: "warn",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    const fingerprint = issueFingerprint(latestIssue)
    const entry = await store.setProcessedIssue({
      projectKey: project.key,
      stage,
      issueId: latestIssue.id || issue.id,
      issueIdentifier: latestIssue.identifier || issue.identifier,
      fingerprint,
      issueUpdatedAt: latestIssue.updatedAt,
      stateName: latestIssue.state?.name,
      runId: run.id,
    })
    await logEvent({
      type: "issue-processed-recorded",
      stage,
      projectKey: project.key,
      issueIdentifier: latestIssue.identifier || issue.identifier,
      runId: run.id,
      message: `${latestIssue.identifier || issue.identifier} 已记录处理快照`,
      data: {
        fingerprint: entry.fingerprint,
        issueUpdatedAt: entry.issueUpdatedAt,
        state: entry.stateName,
      },
    })
  }

  async function getProcessedStartupFailureRun(processed) {
    if (!processed?.runId) {
      return null
    }
    try {
      const run = await store.getRun(processed.runId)
      return isCodexStartupFailureRun(run) ? run : null
    } catch {
      return null
    }
  }

  async function executeCodexStage({
    config,
    project,
    issue,
    stage,
    signal,
    enforceLocalPart2Limit = false,
  }) {
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
    if (
      enforceLocalPart2Limit &&
      stage === "part2" &&
      countLocalActivePart2(project) >= project.maxActivePart2
    ) {
      await logEvent({
        type: "part2-skip-local-active-limit",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: "阶段二本地运行数量已达上限",
        data: {
          localActivePart2Count: countLocalActivePart2(project),
          maxActivePart2: project.maxActivePart2,
        },
      })
      return { status: "skipped-active-limit" }
    }

    const runController = new AbortController()
    const abortFromProject = () => abortRun(runController, abortReason(signal, "用户中止项目任务"))
    if (signal.aborted) {
      abortFromProject()
    } else {
      signal.addEventListener("abort", abortFromProject, { once: true })
    }

    const active = {
      runId: null,
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

    let run = null
    try {
      run = await store.createRun({ projectKey: project.key, stage, issue })
      active.runId = run.id
      activeRunsById.set(run.id, active)
      await logEvent({
        type: "run-start",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: `${issue.identifier} ${stageLabel(stage)} 开始`,
        data: { runDir: run.dir },
      })
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
      if (!run) {
        throw error
      }
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
      if (run?.id) {
        activeRunsById.delete(run.id)
      }
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
    scheduleDaemonTick(0)
  }

  async function runDaemonTick() {
    timer = null
    if (!enabled) {
      return
    }

    try {
      const config = await configProvider()
      if (!enabled) {
        return
      }
      scheduleDaemonTick(config.pollIntervalSeconds * 1000)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      scheduleDaemonTick(60_000)
      return
    }

    activeDaemonScans += 1
    running = true
    void runOnce("both")
      .then(() => {
        lastError = null
      })
      .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        activeDaemonScans = Math.max(0, activeDaemonScans - 1)
        running = activeDaemonScans > 0
      })
  }

  function scheduleDaemonTick(delayMs) {
    if (!enabled) {
      return
    }
    nextRunAt = new Date(Date.now() + delayMs).toISOString()
    timer = setTimeout(() => {
      void runDaemonTick()
    }, delayMs)
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
    for (const cycle of activeProjectCycles) {
      if (cycle.projectKey === projectKey && !cycle.controller.signal.aborted) {
        cycle.controller.abort(reason)
        canceled = true
      }
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
  if (stage === "both") return "全部"
  return stage
}

function part1EligibleStatuses(config) {
  return new Set([
    config.statuses.todo,
    config.statuses.needsClarification,
    config.statuses.blocked,
  ])
}

function issueMatchesId(issue, issueId) {
  const normalized = String(issueId || "").trim().toLowerCase()
  return [issue?.identifier, issue?.id].some((value) => String(value || "").trim().toLowerCase() === normalized)
}

function issueActiveKey(issue) {
  return issue?.id || issue?.identifier || ""
}

function isCodexStartupFailureRun(run) {
  if (!run || run.status !== "failed") {
    return false
  }
  if (run.codexStarted === false) {
    return true
  }
  if (run.codexStarted === true) {
    return false
  }
  return !hasPositiveProcessPid(run.pid) && !hasPositiveProcessPid(run.codexPid)
}

function hasPositiveProcessPid(pid) {
  const numeric = Number(pid)
  return Number.isInteger(numeric) && numeric > 0
}

function issueFingerprint(issue) {
  const payload = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title || "",
    description: issue.description || "",
    updatedAt: issue.updatedAt || "",
    priority: issue.priority || null,
    priorityLabel: issue.priorityLabel || "",
    state: {
      id: issue.state?.id || "",
      name: issue.state?.name || "",
      type: issue.state?.type || "",
    },
    assignee: {
      name: issue.assignee?.name || "",
      email: issue.assignee?.email || "",
    },
    labels: [...(issue.labels || [])]
      .map((label) => ({
        id: label.id || "",
        name: label.name || "",
      }))
      .sort((a, b) => `${a.id}:${a.name}`.localeCompare(`${b.id}:${b.name}`)),
    comments: [...(issue.comments || [])]
      .map((comment) => ({
        id: comment.id || "",
        body: comment.body || "",
        createdAt: comment.createdAt || "",
        updatedAt: comment.updatedAt || "",
        user: {
          name: comment.user?.name || "",
          email: comment.user?.email || "",
        },
      }))
      .sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`)),
  }
  return createHash("md5").update(JSON.stringify(payload)).digest("hex")
}
