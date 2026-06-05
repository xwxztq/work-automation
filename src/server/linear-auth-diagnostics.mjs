export const CODEX_LINEAR_AUTH_FAILURE_KIND = "codex-linear-auth-required"

export const CODEX_LINEAR_AUTH_FAILURE_MESSAGE =
  "Codex 内部 Linear 授权失效，需要重新登录。请运行 `codex mcp login linear` 或在 Codex 中重新连接 Linear 授权后，等待下一轮扫描或手动重试。"

export const CODEX_LINEAR_AUTH_FAILURE_SUMMARY = "Codex Linear 授权失效，需要重新登录"

export const CODEX_LINEAR_AUTH_FAILURE_ACTION =
  "请重新登录 Codex 的 Linear 授权后等待下一轮扫描，或手动重试同一 issue。"

const MAX_TEXT_CHARS = 80_000

export function diagnoseCodexLinearAuthFailure(input = {}) {
  const text = collectDiagnosticText(input)
  if (!text) {
    return null
  }
  const normalized = normalize(text)

  if (hasServerLinearApiKeyFailure(normalized) && !hasCodexLinearToolContext(normalized)) {
    return null
  }
  if (!hasCodexLinearToolContext(normalized)) {
    return null
  }
  if (!hasAuthFailureSignal(normalized)) {
    return null
  }

  return {
    kind: CODEX_LINEAR_AUTH_FAILURE_KIND,
    message: CODEX_LINEAR_AUTH_FAILURE_MESSAGE,
    summary: CODEX_LINEAR_AUTH_FAILURE_SUMMARY,
    action: CODEX_LINEAR_AUTH_FAILURE_ACTION,
    retryable: true,
  }
}

export function isCodexLinearAuthFailureRun(run) {
  return run?.status === "failed" && run.failureKind === CODEX_LINEAR_AUTH_FAILURE_KIND
}

function collectDiagnosticText(input) {
  if (typeof input === "string") {
    return input.slice(0, MAX_TEXT_CHARS)
  }
  if (!input || typeof input !== "object") {
    return ""
  }
  const chunks = [
    input.stdout,
    input.stderr,
    input.final,
    input.finalText,
    input.error,
    input.message,
  ]
  return chunks
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join("\n")
    .slice(0, MAX_TEXT_CHARS)
}

function normalize(text) {
  return String(text || "")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function hasCodexLinearToolContext(text) {
  return [
    /\bmcp__linear\b/,
    /"server"\s*:\s*"linear"/,
    /\blinear\.(get_issue|list_comments|save_issue|save_comment|list_issue_statuses|get_project|get_team)\b/,
    /\blinear\s+(mcp|connector|tool|server|oauth)\b/,
    /\b(mcp|connector|tool|server|oauth)\s+linear\b/,
    /\bcodex\s+mcp\s+login\s+linear\b/,
    /\bmcp\.linear\.app\b/,
  ].some((pattern) => pattern.test(text))
}

function hasAuthFailureSignal(text) {
  return [
    /\bunauthori[sz]ed\b/,
    /\bnot\s+authenticated\b/,
    /\bauthentication\s+(required|failed|expired|missing)\b/,
    /\bauthori[sz]ation\s+(required|failed|expired|missing)\b/,
    /\boauth\b/,
    /\btoken\s+(expired|invalid|missing|revoked)\b/,
    /\binvalid\s+token\b/,
    /\bmissing\s+(credentials?|authentication|authorization)\b/,
    /\b(credentials?|session)\s+(expired|invalid|missing|revoked)\b/,
    /\b(please\s+)?(log|sign)\s+in\b/,
    /\blogin\s+(required|again)\b/,
    /\bre-?login\b/,
    /\bcodex\s+mcp\s+login\s+linear\b/,
    /\b(401|403)\b.*\b(auth|oauth|token|credential|session|login|unauthori[sz]ed)\b/,
    /\b(auth|oauth|token|credential|session|login|unauthori[sz]ed)\b.*\b(401|403)\b/,
    /未授权|认证(失败|过期|失效|缺失|需要)|授权(失败|过期|失效|缺失|需要)|重新登录|需要登录/,
  ].some((pattern) => pattern.test(text))
}

function hasServerLinearApiKeyFailure(text) {
  return /\blinear_api_key\b/.test(text) || /未设置\s+linear_api_key/.test(text)
}
