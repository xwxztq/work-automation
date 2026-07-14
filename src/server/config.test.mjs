import test from "node:test"
import assert from "node:assert/strict"

import { normalizeConfig } from "./config.mjs"

test("notification defaults match the four-stage policy", () => {
  const config = normalizeConfig({})

  assert.deepEqual(config.notifications, {
    part1: { succeeded: true, failed: true },
    split: { succeeded: false, failed: true },
    part2: { succeeded: false, failed: true },
    part3: { succeeded: true, failed: true },
  })
})

test("notification normalization preserves defaults for partial config", () => {
  const config = normalizeConfig({ notifications: { part2: { succeeded: true } } })

  assert.deepEqual(config.notifications.part2, { succeeded: true, failed: true })
  assert.deepEqual(config.notifications.part1, { succeeded: true, failed: true })
})
