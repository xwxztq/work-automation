const WEBHOOK_VARIABLES = ["IssueID", "IssueTitle", "stage", "status"]
const WEBHOOK_VARIABLE_PATTERN = /\{([^{}]+)\}/g

export function validateWebhookUrlTemplate(template) {
  const value = String(template || "").trim()
  if (!value) {
    return "启用 Webhook 时必须填写 URL 模板。"
  }

  const unknownVariables = [...value.matchAll(WEBHOOK_VARIABLE_PATTERN)]
    .map((match) => match[1])
    .filter((name) => !WEBHOOK_VARIABLES.includes(name))
  if (unknownVariables.length) {
    return `Webhook URL 模板包含未知变量: ${[...new Set(unknownVariables)].join(", ")}。`
  }

  try {
    const url = new URL(renderWebhookUrl(value, {
      issueIdentifier: "AGU-1",
      issueTitle: "示例事项",
      stage: "part1",
      status: "succeeded",
    }))
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Webhook URL 模板只支持 http 或 https。"
    }
  } catch {
    return "Webhook URL 模板不是有效的 URL。"
  }

  return null
}

export function renderWebhookUrl(template, run) {
  const values = {
    IssueID: run.issueIdentifier,
    IssueTitle: run.issueTitle,
    stage: run.stage,
    status: run.status,
  }

  return Object.entries(values).reduce(
    (url, [name, value]) => url.replaceAll(`{${name}}`, encodeURIComponent(String(value || ""))),
    String(template || "").trim(),
  )
}

export function shouldSendRunWebhook(config, run) {
  return Boolean(
    config.webhook?.enabled &&
      config.webhook.urlTemplate?.trim() &&
      run.completionSource === "normal" &&
      (run.status === "succeeded" || run.status === "failed") &&
      config.notifications?.[run.stage]?.[run.status],
  )
}

export async function sendRunWebhook({ config, run, fetchImpl = fetch }) {
  if (!shouldSendRunWebhook(config, run)) {
    return { sent: false }
  }

  const renderedUrl = renderWebhookUrl(config.webhook.urlTemplate, run)
  const validationError = validateWebhookUrlTemplate(config.webhook.urlTemplate)
  if (validationError) {
    throw new Error(validationError)
  }
  const target = new URL(renderedUrl)

  let response
  try {
    response = await fetchImpl(target, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "work-automation-webhook/1.0",
      },
    })
  } catch {
    throw new Error(`Webhook 请求失败 (${target.origin})`)
  }

  if (!response.ok) {
    throw new Error(`Webhook 返回 HTTP ${response.status} (${target.origin})`)
  }

  return { sent: true, status: response.status, origin: target.origin }
}
