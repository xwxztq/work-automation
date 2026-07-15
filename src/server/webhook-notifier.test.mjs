import test from "node:test"
import assert from "node:assert/strict"

import {
  renderWebhookUrl,
  sendRunWebhook,
  shouldSendRunWebhook,
  validateWebhookUrlTemplate,
} from "./webhook-notifier.mjs"

const config = {
  webhook: {
    enabled: true,
    urlTemplate: "https://example.com/{IssueID}-{status}/{IssueTitle}?stage={stage}",
  },
  notifications: {
    part1: { succeeded: true, failed: true },
    split: { succeeded: false, failed: true },
    part2: { succeeded: false, failed: true },
    part3: { succeeded: true, failed: true },
  },
}

const run = {
  issueIdentifier: "AGU-39",
  issueTitle: "新增通知推送功能",
  stage: "part3",
  status: "succeeded",
  completionSource: "normal",
}

test("webhook template renders URL-encoded run variables", () => {
  assert.equal(
    renderWebhookUrl(config.webhook.urlTemplate, run),
    "https://example.com/AGU-39-succeeded/%E6%96%B0%E5%A2%9E%E9%80%9A%E7%9F%A5%E6%8E%A8%E9%80%81%E5%8A%9F%E8%83%BD?stage=part3",
  )
})

test("webhook template rejects unknown variables and non-http protocols", () => {
  assert.match(validateWebhookUrlTemplate("https://example.com/{unknown}"), /未知变量/)
  assert.match(validateWebhookUrlTemplate("file:///tmp/{IssueID}"), /http 或 https/)
  assert.equal(validateWebhookUrlTemplate(config.webhook.urlTemplate), null)
})

test("webhook policy excludes disabled results, canceled runs, and reconciled runs", () => {
  assert.equal(shouldSendRunWebhook(config, run), true)
  assert.equal(shouldSendRunWebhook(config, { ...run, stage: "part2" }), false)
  assert.equal(shouldSendRunWebhook(config, { ...run, status: "canceled" }), false)
  assert.equal(shouldSendRunWebhook(config, { ...run, completionSource: "reconciled" }), false)
})

test("webhook delivery uses GET and does not expose the full target in its result", async () => {
  let request
  const result = await sendRunWebhook({
    config,
    run,
    fetchImpl: async (url, init) => {
      request = { url: String(url), init }
      return { ok: true, status: 204 }
    },
  })

  assert.equal(request.init.method, "GET")
  assert.equal(request.url, renderWebhookUrl(config.webhook.urlTemplate, run))
  assert.deepEqual(result, { sent: true, status: 204, origin: "https://example.com" })
})

test("webhook delivery reports HTTP errors without including URL secrets", async () => {
  await assert.rejects(
    sendRunWebhook({
      config: {
        ...config,
        webhook: { enabled: true, urlTemplate: "https://example.com/secret-token/{IssueID}" },
      },
      run,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 503/)
      assert.doesNotMatch(error.message, /secret-token/)
      return true
    },
  )
})
