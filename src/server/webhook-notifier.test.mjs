import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"

import {
  requestWebhook,
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
    env: {},
    requestImpl: async (url, options) => {
      request = { url: String(url), options }
      return { ok: true, status: 204 }
    },
  })

  assert.equal(request.options.method, "GET")
  assert.equal(request.options.timeoutMs, 10_000)
  assert.equal(request.url, renderWebhookUrl(config.webhook.urlTemplate, run))
  assert.deepEqual(result, {
    sent: true,
    status: 204,
    origin: "https://example.com",
    transport: "direct",
  })
})

test("webhook delivery reports HTTP errors without including URL secrets", async () => {
  await assert.rejects(
    sendRunWebhook({
      config: {
        ...config,
        webhook: { enabled: true, urlTemplate: "https://example.com/secret-token/{IssueID}" },
      },
      run,
      env: {},
      requestImpl: async () => ({ ok: false, status: 503 }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 503/)
      assert.doesNotMatch(error.message, /secret-token/)
      return true
    },
  )
})

test("webhook transport performs direct HTTP requests", async (t) => {
  const target = await listen(http.createServer((request, response) => {
    assert.equal(request.url, "/direct")
    response.writeHead(204).end()
  }))
  t.after(() => close(target.server))

  const response = await requestWebhook(new URL("/direct", target.url), {
    env: {},
    timeoutMs: 1_000,
  })

  assert.deepEqual(response, { ok: true, status: 204 })
})

test("webhook transport uses HTTP_PROXY and honors NO_PROXY", async (t) => {
  let proxyConnections = 0
  const target = await listen(http.createServer((_request, response) => {
    response.writeHead(200).end("ok")
  }))
  const targetPort = new URL(target.url).port
  const proxy = http.createServer()
  proxy.on("connect", (_request, clientSocket, head) => {
    proxyConnections += 1
    const upstream = net.connect(Number(targetPort), "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on("error", () => clientSocket.destroy())
  })
  const proxyAddress = await listen(proxy)
  t.after(() => Promise.all([close(proxyAddress.server), close(target.server)]))

  const proxied = await requestWebhook(`http://webhook.invalid:${targetPort}/proxied`, {
    env: { HTTP_PROXY: proxyAddress.url },
    timeoutMs: 1_000,
  })
  assert.deepEqual(proxied, { ok: true, status: 200 })
  assert.equal(proxyConnections, 1)

  const direct = await requestWebhook(new URL("/no-proxy", target.url), {
    env: { HTTP_PROXY: proxyAddress.url, NO_PROXY: "127.0.0.1" },
    timeoutMs: 1_000,
  })
  assert.deepEqual(direct, { ok: true, status: 200 })
  assert.equal(proxyConnections, 1)
})

test("webhook request failures report route and code without URL secrets", async () => {
  const secretConfig = {
    ...config,
    webhook: { enabled: true, urlTemplate: "https://example.com/private-key/{IssueID}" },
  }
  const failure = Object.assign(new Error("private-key leaked"), { code: "ENOTFOUND" })

  await assert.rejects(
    sendRunWebhook({
      config: secretConfig,
      run,
      env: { HTTPS_PROXY: "http://user:proxy-secret@proxy.invalid:8080" },
      requestImpl: async () => { throw failure },
    }),
    (error) => {
      assert.match(error.message, /proxy; ENOTFOUND/)
      assert.doesNotMatch(error.message, /private-key|proxy-secret/)
      return true
    },
  )
})

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
