import test from "node:test"
import assert from "node:assert/strict"

import {
  LINEAR_WRITE_MANUAL_REQUIRED_KIND,
  diagnoseLinearWriteVerification,
} from "./linear-write-verification.mjs"

test("returns manual-handling diagnostic when Linear state is unchanged", () => {
  const diagnostic = diagnoseLinearWriteVerification({
    beforeStateName: "Todo",
    afterStateName: "Todo",
  })

  assert.equal(diagnostic?.kind, LINEAR_WRITE_MANUAL_REQUIRED_KIND)
  assert.equal(diagnostic?.retryable, false)
  assert.match(diagnostic?.summary || "", /Todo/)
})

test("includes refresh failure detail when status verification falls back to the old state", () => {
  const diagnostic = diagnoseLinearWriteVerification({
    beforeStateName: "On Schedule",
    afterStateName: "On Schedule",
    refreshErrorMessage: "getaddrinfo ENOTFOUND api.linear.app",
  })

  assert.match(diagnostic?.message || "", /ENOTFOUND/)
})

test("returns null when Linear state changed", () => {
  const diagnostic = diagnoseLinearWriteVerification({
    beforeStateName: "Todo",
    afterStateName: "Needs Clarification",
  })

  assert.equal(diagnostic, null)
})
