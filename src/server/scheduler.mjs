import { createHash } from "node:crypto"
import { runCodex } from "./codex-runner.mjs"
import { createLinearClient } from "./linear-client.mjs"
import {
  diagnoseCodexLinearAuthFailure,
  isCodexLinearAuthFailureRun,
} from "./linear-auth-diagnostics.mjs"
import { diagnoseLinearWriteVerification } from "./linear-write-verification.mjs"
import { sendRunWebhook } from "./webhook-notifier.mjs"
import {
  buildIssueReviewPromptContext,
  buildPromptContext,
  buildRunPromptContext,
  findLatestCommentByMarker,
  formatPromptComments,
  readPrompt,
  renderPrompt,
} from "./prompts.mjs"
import {
  createLinearStatusHealthChecker,
  formatLinearStatusHealthBlock,
  formatProjectStatusHealthBlock,
  linearStatusHealthIsBlocking,
} from "./status-health.mjs"

const CODEX_HANDOFF_MARKER = "Codex Handoff"
const CODEX_SPLIT_COMPLETE_MARKER = "Codex Split Complete"

export function createScheduler({
  rootDir,
  configProvider,
  store,
  linearStatusHealthChecker = createLinearStatusHealthChecker(),
}) {
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

  async function notifyRunWebhook(config, run) {
    try {
      const delivery = await sendRunWebhook({ config, run })
      if (!delivery.sent) return
      await logEvent({
        type: "webhook-succeeded",
        stage: run.stage,
        projectKey: run.projectKey,
        issueIdentifier: run.issueIdentifier,
        runId: run.id,
        message: `${run.issueIdentifier} ${stageLabel(run.stage)} Webhook 通知成功`,
        data: {
          status: run.status,
          httpStatus: delivery.status,
          origin: delivery.origin,
          transport: delivery.transport,
        },
      })
    } catch (error) {
      await logEvent({
        type: "webhook-failed",
        level: "error",
        stage: run.stage,
        projectKey: run.projectKey,
        issueIdentifier: run.issueIdentifier,
        runId: run.id,
        message: `${run.issueIdentifier} ${stageLabel(run.stage)} Webhook 通知失败: ${error instanceof Error ? error.message : String(error)}`,
        data: { status: run.status },
      })
    }
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
        force: Boolean(options.force),
      },
    })

    const linearStatusHealth = await linearStatusHealthChecker.check(config, { linear })
    if (linearStatusHealthIsBlocking(linearStatusHealth)) {
      summary.projects = await blockProjectsForLinearStatusHealth({
        projects,
        stage,
        statusHealth: linearStatusHealth,
      })
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

    summary.projects = await Promise.all(
      projects.map((project) =>
        runProjectCycle({ config, project, linear, stage, issueId: options.issueId, force: Boolean(options.force) }).catch(async (error) => {
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
            split: [],
            part2: [],
            part3: [],
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

  async function blockProjectsForLinearStatusHealth({ projects, stage, statusHealth }) {
    const globalMessage = formatLinearStatusHealthBlock(statusHealth)
    const healthByProjectKey = new Map(statusHealth.projects.map((project) => [project.projectKey, project]))
    await logEvent({
      type: "linear-status-health-blocked",
      level: "error",
      stage,
      projectKey: null,
      message: globalMessage,
      data: { health: statusHealth },
    })

    return projects.map((project) => {
      const projectHealth = healthByProjectKey.get(project.key)
      return {
        key: project.key,
        part1: [],
        split: [],
        part2: [],
        part3: [],
        skipped: [
          projectHealth && !projectHealth.ok
            ? formatProjectStatusHealthBlock(projectHealth)
            : globalMessage,
        ],
      }
    })
  }

  async function runProjectCycle({ config, project, linear, stage, issueId, force = false }) {
    const projectSummary = {
      key: project.key,
      part1: [],
      split: [],
      part2: [],
      part3: [],
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
        data: { issueId, force },
      })
      const effectiveStage =
        issueId && stage === "both"
          ? await resolveManualIssueStage({ config, project, linear, projectSummary, issueId, force })
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
                force,
                signal: controller.signal,
              }),
          }),
          runProjectStageBranch({
            project,
            stage: "split",
            projectSummary,
            run: () =>
              runProjectSplit({
                config,
                project,
                linear,
                projectSummary,
                issueId,
                force,
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
                force,
                signal: controller.signal,
              }),
          }),
          runProjectStageBranch({
            project,
            stage: "part3",
            projectSummary,
            run: () =>
              runProjectPart3({
                config,
                project,
                linear,
                projectSummary,
                issueId,
                force,
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
          force,
          signal: controller.signal,
        })
      } else if (!controller.signal.aborted && effectiveStage === "split") {
        await runProjectSplit({
          config,
          project,
          linear,
          projectSummary,
          issueId,
          force,
          signal: controller.signal,
        })
      } else if (!controller.signal.aborted && effectiveStage === "part2") {
        await runProjectPart2({
          config,
          project,
          linear,
          projectSummary,
          issueId,
          force,
          signal: controller.signal,
        })
      } else if (!controller.signal.aborted && effectiveStage === "part3") {
        await runProjectPart3({
          config,
          project,
          linear,
          projectSummary,
          issueId,
          force,
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
          split: projectSummary.split.length,
          part2: projectSummary.part2.length,
          part3: projectSummary.part3.length,
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

  async function resolveManualIssueStage({ config, project, linear, projectSummary, issueId, force = false }) {
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
          force,
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
          force,
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
          force,
        },
      })
      return null
    }

    const stateName = issue.state?.name
    const eligiblePart1Statuses = part1EligibleStatuses(config)
    let effectiveStage = null
    if (eligiblePart1Statuses.has(stateName)) {
      effectiveStage = "part1"
    } else if (stateName === config.statuses.needsSplitting) {
      effectiveStage = "split"
    } else if (stateName === config.statuses.schedule) {
      effectiveStage = "part2"
    } else if (stateName === config.statuses.testing) {
      effectiveStage = "part3"
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
          force,
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
        splitStatus: config.statuses.needsSplitting,
        part2Status: config.statuses.schedule,
        part3Status: config.statuses.testing,
        force,
      },
    })
    return null
  }

  async function runProjectPart1({ config, project, linear, projectSummary, issueId, force = false, signal }) {
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
        force,
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
          force,
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
    force,
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
      if (!force && !eligibleStatuses.has(issue.state?.name)) {
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
      if (!force && !issueId && (await skipUnchangedIssue({ project, issue, stage: "part1", projectSummary }))) {
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
      const finalizedRun = await recordProcessedIssue({ linear, project, issue, stage: "part1", run: result })
      return { issue: issue.identifier, result: finalizedRun.status }
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

  async function runProjectPart2({ config, project, linear, projectSummary, issueId, force = false, signal }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const candidates = issueId
      ? issues.filter((issue) => issueMatchesId(issue, issueId))
      : issues.filter((issue) => issue.state?.name === config.statuses.schedule)
    const activeStats = await activePart2StatsFromIssues(issues, project, config)

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
        force,
      },
    })

    for (const issueRef of candidates.sort(comparePart2ScheduleOrder)) {
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
      if (!force && issue.state?.name !== config.statuses.schedule) {
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
      if (!force && !issueId && (await skipUnchangedIssue({ project, issue, stage: "part2", projectSummary }))) {
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
      const finalizedRun = await recordProcessedIssue({ linear, project, issue, stage: "part2", run: result })
      projectSummary.part2.push({ issue: issue.identifier, result: finalizedRun.status })
    }
  }

  async function runProjectSplit({ config, project, linear, projectSummary, issueId, force = false, signal }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const candidates = issueId
      ? issues.filter((issue) => issueMatchesId(issue, issueId))
      : issues.filter((issue) => issue.state?.name === config.statuses.needsSplitting)

    await logEvent({
      type: "split-candidates",
      stage: "split",
      projectKey: project.key,
      message: `拆分阶段候选 ${candidates.length} 个`,
      data: {
        issueCount: issues.length,
        candidateCount: candidates.length,
        issueId,
        force,
      },
    })

    for (const issueRef of candidates.sort(comparePart2ScheduleOrder)) {
      if (signal.aborted) {
        await logEvent({
          type: "split-aborted",
          level: "warn",
          stage: "split",
          projectKey: project.key,
          message: "拆分阶段项目信号已中止，停止处理后续候选",
        })
        break
      }

      const issue = await linear.getIssue(issueRef.identifier || issueRef.id)
      if (!force && issue.state?.name !== config.statuses.needsSplitting) {
        projectSummary.skipped.push(`${issue.identifier}: 状态已不是 ${config.statuses.needsSplitting}`)
        await logEvent({
          type: "split-skip-state-changed",
          stage: "split",
          projectKey: project.key,
          issueIdentifier: issue.identifier,
          message: `${issue.identifier} 状态已不是 ${config.statuses.needsSplitting}，跳过`,
          data: { state: issue.state?.name },
        })
        continue
      }
      if (!force && !issueId && (await skipUnchangedIssue({ project, issue, stage: "split", projectSummary }))) {
        continue
      }

      await logEvent({
        type: "run-queue",
        stage: "split",
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `${issue.identifier} 进入拆分阶段执行`,
        data: { state: issue.state?.name },
      })
      const result = await executeCodexStage({
        config,
        project,
        issue,
        stage: "split",
        signal,
      })
      const finalizedRun = await recordProcessedIssue({ linear, project, issue, stage: "split", run: result })
      projectSummary.split.push({ issue: issue.identifier, result: finalizedRun.status })
    }
  }

  async function runProjectPart3({ config, project, linear, projectSummary, issueId, force = false, signal }) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    const candidates = issueId
      ? issues.filter((issue) => issueMatchesId(issue, issueId))
      : issues.filter((issue) => issue.state?.name === config.statuses.testing)

    await logEvent({
      type: "part3-candidates",
      stage: "part3",
      projectKey: project.key,
      message: `阶段三候选 ${candidates.length} 个`,
      data: {
        issueCount: issues.length,
        candidateCount: candidates.length,
        issueId,
        force,
      },
    })

    for (const issueRef of candidates.sort(comparePart2ScheduleOrder)) {
      if (signal.aborted) {
        await logEvent({
          type: "part3-aborted",
          level: "warn",
          stage: "part3",
          projectKey: project.key,
          message: "阶段三项目信号已中止，停止处理后续候选",
        })
        break
      }

      const issue = await linear.getIssue(issueRef.identifier || issueRef.id)
      if (!force && issue.state?.name !== config.statuses.testing) {
        projectSummary.skipped.push(`${issue.identifier}: 状态已不是 ${config.statuses.testing}`)
        await logEvent({
          type: "part3-skip-state-changed",
          stage: "part3",
          projectKey: project.key,
          issueIdentifier: issue.identifier,
          message: `${issue.identifier} 状态已不是 ${config.statuses.testing}，跳过`,
          data: { state: issue.state?.name },
        })
        continue
      }
      if (!force && !issueId && (await skipUnchangedIssue({ project, issue, stage: "part3", projectSummary }))) {
        continue
      }

      await logEvent({
        type: "run-queue",
        stage: "part3",
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: `${issue.identifier} 进入阶段三执行`,
        data: { state: issue.state?.name },
      })
      const result = await executeCodexStage({
        config,
        project,
        issue,
        stage: "part3",
        signal,
      })
      const finalizedRun = await recordProcessedIssue({ linear, project, issue, stage: "part3", run: result })
      projectSummary.part3.push({ issue: issue.identifier, result: finalizedRun.status })
    }
  }

  async function countActivePart2(linear, project, config) {
    const { issues } = await linear.listProjectIssues(project.linearProjectId)
    return activePart2StatsFromIssues(issues, project, config)
  }

  async function activePart2StatsFromIssues(issues, project, config) {
    const linearIssueKeys = new Set()
    for (const issue of issues) {
      if (!issueCountsTowardPart2ActiveLimit(issue, config)) {
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
    for (const run of await persistedRunningRuns()) {
      if (run.projectKey !== project.key || run.stage !== "part2") {
        continue
      }
      const key = issueActiveKey({
        id: run.issueId,
        identifier: run.issueIdentifier,
      })
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

  async function countLocalActivePart2(project) {
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
    for (const run of await persistedRunningRuns()) {
      if (run.projectKey !== project.key || run.stage !== "part2") {
        continue
      }
      const key = issueActiveKey({
        id: run.issueId,
        identifier: run.issueIdentifier,
      })
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
    const linearAuthFailureRun = await getProcessedCodexLinearAuthFailureRun(processed)
    if (linearAuthFailureRun) {
      await logEvent({
        type: "issue-retry-after-linear-auth-failure",
        level: "warn",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: linearAuthFailureRun.id,
        message: `${issue.identifier} 上次处理快照来自 Codex Linear 授权失效，本轮继续重试`,
        data: {
          fingerprint,
          recordedAt: processed.recordedAt,
          issueUpdatedAt: issue.updatedAt,
          state: issue.state?.name,
          failureKind: linearAuthFailureRun.failureKind,
          action: linearAuthFailureRun.failureAction || null,
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
      return run
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
      return run
    }
    if (isCodexLinearAuthFailureRun(run)) {
      await logEvent({
        type: "issue-processed-not-recorded",
        level: "warn",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: `${issue.identifier} Codex Linear 授权失效，需要重新登录，未记录处理快照`,
        data: {
          runStatus: run.status,
          codexStarted: run.codexStarted,
          failureKind: run.failureKind,
          retryable: true,
          action: run.failureAction || null,
        },
      })
      return run
    }
    let latestIssue = issue
    let refreshErrorMessage = null
    try {
      latestIssue = await linear.getIssue(issue.identifier || issue.id)
    } catch (error) {
      refreshErrorMessage = error instanceof Error ? error.message : String(error)
      await logEvent({
        type: "processed-refresh-failed",
        level: "warn",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: refreshErrorMessage,
      })
    }
    if (run.status === "succeeded") {
      const verification = diagnoseLinearWriteVerification({
        beforeStateName: issue.state?.name,
        afterStateName: latestIssue.state?.name,
        refreshErrorMessage,
      })
      if (verification) {
        run = await store.updateRun(run, {
          status: "failed",
          error: verification.message,
          failureKind: verification.kind,
          failureSummary: verification.summary,
          failureAction: verification.action,
          retryableFailure: verification.retryable,
        })
        await logEvent({
          type: "run-linear-manual-required",
          level: "error",
          stage,
          projectKey: project.key,
          issueIdentifier: issue.identifier,
          runId: run.id,
          message: verification.summary,
          data: {
            beforeState: issue.state?.name || null,
            afterState: latestIssue.state?.name || null,
            refreshError: refreshErrorMessage,
          },
        })
      }
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
    return run
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

  async function getProcessedCodexLinearAuthFailureRun(processed) {
    if (!processed?.runId) {
      return null
    }
    try {
      const run = await store.getRun(processed.runId)
      return isCodexLinearAuthFailureRun(run) ? run : null
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
    const persistedActiveRun = await findPersistedActiveRun(project.key, stage, issue)
    if (persistedActiveRun) {
      await logEvent({
        type: "run-skip-persisted-active",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: persistedActiveRun.id,
        message: `${issue.identifier} 已有持久化运行仍在执行中`,
        data: {
          pid: persistedActiveRun.pid || null,
          supervisorPid: persistedActiveRun.supervisorPid || null,
          codexPid: persistedActiveRun.codexPid || null,
        },
      })
      return { status: "already-running", id: persistedActiveRun.id }
    }
    if (
      enforceLocalPart2Limit &&
      stage === "part2" &&
      (await countLocalActivePart2(project)) >= project.maxActivePart2
    ) {
      const localActivePart2Count = await countLocalActivePart2(project)
      await logEvent({
        type: "part2-skip-local-active-limit",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        message: "阶段二本地运行数量已达上限",
        data: {
          localActivePart2Count,
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
      supervisorPid: null,
      codexPid: null,
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

      const prompt = await buildStagePrompt({ config, project, issue, stage, run })
      const codexResult = await runCodex({
        config,
        project,
        stage,
        run,
        prompt,
        store,
        signal: runController.signal,
        onChild: (processInfo) => {
          active.pid = processInfo.pid || null
          active.supervisorPid = processInfo.supervisorPid || null
          if (active.pid) {
            void logEvent({
              type: "run-supervisor",
              stage,
              projectKey: project.key,
              issueIdentifier: issue.identifier,
              runId: run.id,
              message: `${issue.identifier} Codex supervisor 已启动`,
              data: {
                pid: active.pid,
                supervisorPid: active.supervisorPid,
              },
            })
          }
        },
      })

      if (codexResult.canceled || runController.signal.aborted) {
        return await markRunCanceled(run, runController.signal, {
          exitCode: codexResult.exitCode,
          pid: active.pid,
          supervisorPid: codexResult.supervisorPid || active.supervisorPid,
          codexPid: codexResult.codexPid || active.codexPid,
          codexStarted: codexResult.started,
        })
      }

      const succeeded = codexResult.exitCode === 0
      const startupError = codexResult.started
        ? null
        : codexResult.startError || `Codex 子进程未成功启动（退出码 ${codexResult.exitCode}）`
      const fallbackError = startupError || `Codex 退出码为 ${codexResult.exitCode}`
      const authDiagnostic = succeeded
        ? null
        : await diagnoseRunFailure(run, {
            finalText: codexResult.finalText,
            error: fallbackError,
          })
      active.supervisorPid = codexResult.supervisorPid || active.supervisorPid
      active.codexPid = codexResult.codexPid || active.codexPid
      run = await store.updateRun(run, {
        status: succeeded ? "succeeded" : "failed",
        completionSource: "normal",
        exitCode: codexResult.exitCode,
        pid: active.pid,
        supervisorPid: active.supervisorPid,
        codexPid: active.codexPid,
        codexStarted: codexResult.started,
        startupError,
        error: succeeded ? undefined : authDiagnostic?.message || fallbackError,
        failureKind: authDiagnostic?.kind,
        failureSummary: authDiagnostic?.summary,
        failureAction: authDiagnostic?.action,
        retryableFailure: authDiagnostic?.retryable,
      })
      await logEvent({
        type: succeeded ? "run-succeeded" : authDiagnostic ? "run-codex-linear-auth-required" : "run-failed",
        level: succeeded ? "info" : "error",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: succeeded
          ? `${issue.identifier} ${stageLabel(stage)} 成功`
          : authDiagnostic
            ? `${issue.identifier} ${stageLabel(stage)}失败: ${authDiagnostic.summary}`
            : `${issue.identifier} ${stageLabel(stage)} ${startupError ? `启动失败: ${startupError}` : `失败: ${fallbackError}`}`,
        data: {
          exitCode: codexResult.exitCode,
          runDir: run.dir,
          codexStarted: codexResult.started,
          startupError,
          failureKind: authDiagnostic?.kind,
          retryableFailure: authDiagnostic?.retryable,
          action: authDiagnostic?.action,
        },
      })
      await notifyRunWebhook(config, run)
      return run
    } catch (error) {
      if (!run) {
        throw error
      }
      if (runController.signal.aborted) {
        return await markRunCanceled(run, runController.signal, {
          pid: active.pid,
          supervisorPid: active.supervisorPid,
          codexPid: active.codexPid,
        })
      }
      const codexStarted = Boolean(active.codexPid)
      const errorMessage = error instanceof Error ? error.message : String(error)
      const authDiagnostic = await diagnoseRunFailure(run, { error: errorMessage })
      run = await store.updateRun(run, {
        status: "failed",
        completionSource: "normal",
        pid: active.pid,
        supervisorPid: active.supervisorPid,
        codexPid: active.codexPid,
        codexStarted,
        startupError: codexStarted ? null : errorMessage,
        error: authDiagnostic?.message || errorMessage,
        failureKind: authDiagnostic?.kind,
        failureSummary: authDiagnostic?.summary,
        failureAction: authDiagnostic?.action,
        retryableFailure: authDiagnostic?.retryable,
      })
      await logEvent({
        type: authDiagnostic ? "run-codex-linear-auth-required" : "run-error",
        level: "error",
        stage,
        projectKey: project.key,
        issueIdentifier: issue.identifier,
        runId: run.id,
        message: authDiagnostic?.summary || errorMessage,
        data: {
          runDir: run.dir,
          failureKind: authDiagnostic?.kind,
          retryableFailure: authDiagnostic?.retryable,
          action: authDiagnostic?.action,
        },
      })
      await notifyRunWebhook(config, run)
      throw error
    } finally {
      signal.removeEventListener("abort", abortFromProject)
      activeRunsByKey.delete(key)
      if (run?.id) {
        activeRunsById.delete(run.id)
      }
    }
  }

  async function diagnoseRunFailure(run, extra = {}) {
    let detail = null
    try {
      detail = await store.getRun(run.id)
    } catch {
      detail = null
    }
    return diagnoseCodexLinearAuthFailure({
      stdout: detail?.stdout,
      stderr: detail?.stderr,
      final: detail?.final,
      finalText: extra.finalText,
      error: extra.error || detail?.error || run.error || run.startupError,
    })
  }

  async function buildStagePrompt({ config, project, issue, stage, run }) {
    const promptMode =
      stage === "part1"
        ? project.part1PromptMode
        : stage === "split"
          ? project.splitPromptMode
          : stage === "part2"
          ? project.part2PromptMode
          : project.part3PromptMode
    const scope = promptMode === "override" ? project.key : "global"
    const template = await readPrompt(rootDir, scope, stage)
    const extraContext =
      stage === "part3"
        ? {
            ...buildRunPromptContext(rootDir, run),
            ...buildIssueReviewPromptContext(issue),
          }
        : {}
    const context = buildPromptContext(config, project, extraContext)
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
${formatPromptComments(issue.comments || [], 20)}
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

  async function cancelRun(runId, reason = "用户中止任务") {
    const active = activeRunsById.get(runId)
    if (!active) {
      const persisted = await getPersistedRun(runId)
      if (!persisted || persisted.status !== "running") {
        return { ok: false, error: "未找到正在运行的任务" }
      }
      const canceled = await cancelPersistedRun(persisted, reason)
      if (!canceled) {
        return { ok: false, error: "运行进程已不存在" }
      }
      await logEvent({
        type: "cancel-run",
        level: "warn",
        projectKey: persisted.projectKey,
        stage: persisted.stage,
        issueIdentifier: persisted.issueIdentifier,
        runId: persisted.id,
        message: reason,
        data: {
          pid: persisted.pid || null,
          supervisorPid: persisted.supervisorPid || null,
          codexPid: persisted.codexPid || null,
        },
      })
      return { ok: true, runId }
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

  async function cancelProject(projectKey, reason = "用户中止项目任务") {
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
    for (const run of await persistedRunningRuns()) {
      if (run.projectKey === projectKey) {
        canceled = (await cancelPersistedRun(run, reason)) || canceled
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

  async function status() {
    const activeRuns = await activeRunSummaries()
    return {
      running: running || activeRuns.length > 0,
      enabled,
      nextRunAt,
      lastError,
      activeRuns,
    }
  }

  async function activeRunSummaries() {
    const activeById = new Map()
    for (const active of activeRunsById.values()) {
      if (!active.runId) {
        continue
      }
      activeById.set(active.runId, {
        runId: active.runId,
        projectKey: active.projectKey,
        stage: active.stage,
        startedAt: active.startedAt,
        pid: active.pid,
        supervisorPid: active.supervisorPid,
        codexPid: active.codexPid,
        issue: active.issue,
      })
    }
    for (const run of await persistedRunningRuns()) {
      if (activeById.has(run.id)) {
        continue
      }
      activeById.set(run.id, {
        runId: run.id,
        projectKey: run.projectKey,
        stage: run.stage,
        startedAt: run.createdAt,
        pid: run.pid || null,
        supervisorPid: run.supervisorPid || null,
        codexPid: run.codexPid || null,
        issue: {
          id: run.issueId,
          identifier: run.issueIdentifier,
          title: run.issueTitle,
        },
      })
    }
    return [...activeById.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  }

  async function findPersistedActiveRun(projectKey, stage, issue) {
    const key = issueActiveKey(issue)
    for (const run of await persistedRunningRuns()) {
      if (run.projectKey !== projectKey || run.stage !== stage) {
        continue
      }
      const runIssueKey = issueActiveKey({
        id: run.issueId,
        identifier: run.issueIdentifier,
      })
      if (runIssueKey === key) {
        return run
      }
    }
    return null
  }

  async function persistedRunningRuns() {
    const runs = await store.listRuns(500)
    const active = []
    for (const run of runs) {
      if (run.status !== "running") {
        continue
      }
      if (activeRunsById.has(run.id) || isWithinStartupGrace(run)) {
        active.push(run)
        continue
      }
      if (isRunAlive(run)) {
        active.push(run)
        continue
      }
      await markRunLost(run)
    }
    return active
  }

  async function markRunLost(run) {
    const detail = await store.getRun(run.id)
    const hasFinalText = Boolean(detail?.final?.trim())
    const next = await store.updateRun(run, lostRunCompletionPatch(hasFinalText))
    await logEvent({
      type: "run-reconciled-missing-process",
      level: hasFinalText ? "info" : "warn",
      stage: run.stage,
      projectKey: run.projectKey,
      issueIdentifier: run.issueIdentifier,
      runId: run.id,
      message: hasFinalText ? "运行进程已结束，检测到最终结果并标记成功" : next.error,
      data: {
        pid: run.pid || null,
        supervisorPid: run.supervisorPid || null,
        codexPid: run.codexPid || null,
      },
    })
  }

  async function getPersistedRun(runId) {
    const runs = await store.listRuns(500)
    return runs.find((run) => run.id === runId) || null
  }

  async function cancelPersistedRun(run, reason) {
    const supervisorPid = positivePid(run.supervisorPid)
    const pid = positivePid(run.pid)
    const codexPid = positivePid(run.codexPid)
    const targetPid = supervisorPid || pid || codexPid
    if (!targetPid || !isPidAlive(targetPid)) {
      return false
    }
    try {
      process.kill(targetPid, "SIGTERM")
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false
      }
      throw error
    }
    if (!supervisorPid) {
      await store.updateRun(run, {
        status: "canceled",
        canceledAt: new Date().toISOString(),
        cancelReason: reason,
      })
    }
    return true
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
      supervisorPid: patch.supervisorPid,
      codexPid: patch.codexPid,
      codexStarted: patch.codexStarted,
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

export function lostRunCompletionPatch(hasFinalText) {
  return {
    status: hasFinalText ? "succeeded" : "failed",
    completionSource: "reconciled",
    error: hasFinalText
      ? undefined
      : "运行进程已不存在，已从持久化运行记录中标记为失败。",
  }
}

function getLinear(config) {
  const apiKeyEnv = config.linear?.apiKeyEnv || "LINEAR_API_KEY"
  const apiKey = process.env[apiKeyEnv]
  if (!apiKey) {
    return null
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

function comparePart2ScheduleOrder(a, b) {
  const priorityDiff = linearPriorityRank(a?.priority) - linearPriorityRank(b?.priority)
  if (priorityDiff !== 0) {
    return priorityDiff
  }
  const issueNumberA = linearIssueNumber(a)
  const issueNumberB = linearIssueNumber(b)
  if (issueNumberA !== null && issueNumberB !== null) {
    const issueNumberDiff = issueNumberA - issueNumberB
    if (issueNumberDiff !== 0) {
      return issueNumberDiff
    }
  } else if (issueNumberA !== null) {
    return -1
  } else if (issueNumberB !== null) {
    return 1
  }
  const updatedAtDiff = String(a?.updatedAt || "").localeCompare(String(b?.updatedAt || ""))
  if (updatedAtDiff !== 0) {
    return updatedAtDiff
  }
  return String(issueActiveKey(a)).localeCompare(String(issueActiveKey(b)))
}

function linearPriorityRank(priority) {
  const numeric = Number(priority)
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 4 ? numeric : 5
}

function linearIssueNumber(issue) {
  const match = String(issue?.identifier || "").match(/-(\d+)$/)
  if (!match) {
    return null
  }
  const numeric = Number(match[1])
  return Number.isSafeInteger(numeric) ? numeric : null
}

function stageLabel(stage) {
  if (stage === "part1") return "阶段一"
  if (stage === "split") return "拆分阶段"
  if (stage === "part2") return "阶段二"
  if (stage === "part3") return "阶段三"
  if (stage === "both") return "全部"
  return stage
}

export function issueCountsTowardPart2ActiveLimit(issue, config) {
  if (issue.state?.name !== config.statuses.inProgress) {
    return false
  }
  const latestHandoff = findLatestCommentByMarker(issue.comments || [], CODEX_HANDOFF_MARKER)
  if (!latestHandoff) {
    return false
  }
  const latestSplitComplete = findLatestCommentByMarker(
    issue.comments || [],
    CODEX_SPLIT_COMPLETE_MARKER,
  )
  if (!latestSplitComplete) {
    return true
  }
  return String(latestHandoff.createdAt || "").localeCompare(
    String(latestSplitComplete.createdAt || ""),
  ) >= 0
}

export function part1EligibleStatuses(config) {
  return new Set([
    config.statuses.todo,
    config.statuses.needsClarification,
    config.statuses.tooLarge,
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

function isRunAlive(run) {
  return [run.supervisorPid, run.pid, run.codexPid].some((pid) => isPidAlive(pid))
}

function isWithinStartupGrace(run) {
  if (run.supervisorPid || run.pid || run.codexPid) {
    return false
  }
  const createdAt = Date.parse(run.createdAt || "")
  return Number.isFinite(createdAt) && Date.now() - createdAt < 15_000
}

function positivePid(pid) {
  const numeric = Number(pid)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null
}

function isPidAlive(pid) {
  const numeric = positivePid(pid)
  if (!numeric) {
    return false
  }
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
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
