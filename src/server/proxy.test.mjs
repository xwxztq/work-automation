import test from "node:test"
import assert from "node:assert/strict"

import { matchesNoProxy, resolveProxyUrl } from "./proxy.mjs"

test("proxy selection follows the target protocol and lowercase precedence", () => {
  const env = {
    HTTP_PROXY: "http://uppercase-http:8080",
    http_proxy: "http://lowercase-http:8080",
    HTTPS_PROXY: "http://uppercase-https:8080",
    https_proxy: "http://lowercase-https:8080",
  }

  assert.equal(resolveProxyUrl("http://example.com", env), "http://lowercase-http:8080")
  assert.equal(resolveProxyUrl("https://example.com", env), "http://lowercase-https:8080")
})

test("NO_PROXY supports domains, subdomains, ports, IPv6, and wildcard", () => {
  assert.equal(matchesNoProxy("https://api.example.com", ".example.com"), true)
  assert.equal(matchesNoProxy("https://example.com:8443", "example.com:443"), false)
  assert.equal(matchesNoProxy("https://example.com:8443", "example.com:8443"), true)
  assert.equal(matchesNoProxy("http://[::1]:4378", "[::1]:4378"), true)
  assert.equal(matchesNoProxy("https://anything.invalid", "*"), true)
})

test("NO_PROXY bypasses configured proxies", () => {
  assert.equal(
    resolveProxyUrl("https://api.example.com", {
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "example.com",
    }),
    null,
  )
})
