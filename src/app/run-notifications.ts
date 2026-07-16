import type { AppConfig, RunSummary } from "@/shared/types"

type NotificationRun = Pick<
  RunSummary,
  "id" | "status" | "stage" | "createdAt" | "updatedAt" | "completionSource"
>

export type BrowserNotificationTracker = {
  sessionStartedAt: number
  observedStatuses: Map<string, RunSummary["status"]>
  eligibleRunIds: Set<string>
  deliveredRunIds: Set<string>
}

export function createBrowserNotificationTracker(
  initialRuns: NotificationRun[],
  sessionStartedAt = Date.now(),
): BrowserNotificationTracker {
  return {
    sessionStartedAt,
    observedStatuses: new Map(initialRuns.map((run) => [run.id, run.status])),
    eligibleRunIds: new Set(),
    deliveredRunIds: new Set(),
  }
}

export function collectBrowserNotificationCandidates<TRun extends NotificationRun>(
  tracker: BrowserNotificationTracker,
  runs: TRun[],
  notifications: AppConfig["notifications"],
) {
  const candidates: TRun[] = []

  for (const run of runs) {
    const previousStatus = tracker.observedStatuses.get(run.id)
    const resultStatus = run.status === "succeeded" || run.status === "failed"
      ? run.status
      : null
    const isTerminal = resultStatus !== null
    const isNormalCompletion = run.completionSource === "normal"
    const createdDuringSession = timestamp(run.createdAt) >= tracker.sessionStartedAt
    const completedDuringSession = timestamp(run.updatedAt) >= tracker.sessionStartedAt
    const newlyCompleted = previousStatus === "running"
      || (previousStatus === undefined && createdDuringSession && completedDuringSession)

    tracker.observedStatuses.set(run.id, run.status)

    if (
      newlyCompleted
      && isTerminal
      && isNormalCompletion
      && notifications[run.stage]?.[resultStatus]
    ) {
      tracker.eligibleRunIds.add(run.id)
    }

    if (!isTerminal || !isNormalCompletion) {
      tracker.eligibleRunIds.delete(run.id)
      continue
    }

    if (
      tracker.eligibleRunIds.has(run.id)
      && !tracker.deliveredRunIds.has(run.id)
      && notifications[run.stage]?.[resultStatus]
    ) {
      candidates.push(run)
    }
  }

  return candidates
}

export function markBrowserNotificationDelivered(
  tracker: BrowserNotificationTracker,
  runId: string,
) {
  tracker.deliveredRunIds.add(runId)
  tracker.eligibleRunIds.delete(runId)
}

function timestamp(value: string) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}
