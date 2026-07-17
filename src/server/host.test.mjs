import assert from "node:assert/strict"
import test from "node:test"
import {
  ALLOW_WILDCARD_HOST_ENV,
  isWildcardHostAllowed,
  validateHost,
} from "./host.mjs"

test("wildcard hosts remain disabled by default", () => {
  assert.match(validateHost("0.0.0.0"), /不能使用/)
})

test("wildcard hosts can be enabled explicitly for a container", () => {
  assert.equal(validateHost("0.0.0.0", { allowWildcard: true }), "")
  assert.equal(isWildcardHostAllowed({ [ALLOW_WILDCARD_HOST_ENV]: "1" }), true)
  assert.equal(isWildcardHostAllowed({ [ALLOW_WILDCARD_HOST_ENV]: "true" }), true)
  assert.equal(isWildcardHostAllowed({ [ALLOW_WILDCARD_HOST_ENV]: "0" }), false)
})
