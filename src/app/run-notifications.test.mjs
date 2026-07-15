import test from "node:test"
import assert from "node:assert/strict"

import {
  collectBrowserNotificationCandidates,
  createBrowserNotificationTracker,
  markBrowserNotificationDelivered,
} from "./run-notifications.ts"

const notifications = {
  part1: { succeeded: true, failed: true },
  split: { succeeded: false, failed: true },
  part2: { succeeded: false, failed: true },
  part3: { succeeded: true, failed: true },
}

const startedAt = Date.parse("2026-07-15T08:00:00.000Z")
const baseRun = {
  id: "run-1",
  stage: "part1",
  status: "running",
  createdAt: "2026-07-15T08:00:01.000Z",
  updatedAt: "2026-07-15T08:00:02.000Z",
  completionSource: "normal",
}

test("initial terminal runs establish a baseline without backfilling notifications", () => {
  const completed = { ...baseRun, status: "succeeded" }
  const tracker = createBrowserNotificationTracker([completed], startedAt)

  assert.deepEqual(collectBrowserNotificationCandidates(tracker, [completed], notifications), [])
})

test("an observed running run notifies once when it completes normally", () => {
  const tracker = createBrowserNotificationTracker([baseRun], startedAt)
  const completed = {
    ...baseRun,
    status: "succeeded",
    updatedAt: "2026-07-15T08:05:00.000Z",
  }

  assert.deepEqual(collectBrowserNotificationCandidates(tracker, [completed], notifications), [completed])
  markBrowserNotificationDelivered(tracker, completed.id)
  assert.deepEqual(collectBrowserNotificationCandidates(tracker, [completed], notifications), [])
})

test("a new terminal run remains eligible when polling misses its running state", () => {
  const tracker = createBrowserNotificationTracker([], startedAt)
  const completed = {
    ...baseRun,
    status: "failed",
    createdAt: "2026-07-15T08:01:00.000Z",
    updatedAt: "2026-07-15T08:01:05.000Z",
  }

  assert.deepEqual(collectBrowserNotificationCandidates(tracker, [completed], notifications), [completed])
  assert.deepEqual(collectBrowserNotificationCandidates(tracker, [completed], notifications), [completed])
})

test("reconciled, canceled, and disabled results are excluded", () => {
  const tracker = createBrowserNotificationTracker([], startedAt)
  const runs = [
    { ...baseRun, id: "reconciled", status: "succeeded", completionSource: "reconciled" },
    { ...baseRun, id: "canceled", status: "canceled" },
    { ...baseRun, id: "disabled", stage: "part2", status: "succeeded" },
  ]

  assert.deepEqual(collectBrowserNotificationCandidates(tracker, runs, notifications), [])
})
