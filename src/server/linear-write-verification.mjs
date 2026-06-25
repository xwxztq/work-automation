export const LINEAR_WRITE_MANUAL_REQUIRED_KIND = "linear-write-manual-required"
export const LINEAR_WRITE_MANUAL_REQUIRED_SUMMARY = "Linear 状态未变化，需要人工处理"
export const LINEAR_WRITE_MANUAL_REQUIRED_ACTION =
  "请检查 Linear 写回通道，或直接在 Linear 中人工处理；服务不会自动重试同一快照。"

export function diagnoseLinearWriteVerification({
  beforeStateName,
  afterStateName,
  refreshErrorMessage,
} = {}) {
  const before = normalizeStateName(beforeStateName)
  const after = normalizeStateName(afterStateName)

  if (!before || !after || before !== after) {
    return null
  }

  const stateLabel = String(afterStateName || beforeStateName || "原状态").trim()
  const refreshSuffix = refreshErrorMessage ? `；刷新 Linear 失败: ${refreshErrorMessage}` : ""

  return {
    kind: LINEAR_WRITE_MANUAL_REQUIRED_KIND,
    message: `Codex 执行结束后，Linear 状态仍为 ${stateLabel}，需要人工处理${refreshSuffix}`,
    summary: `${LINEAR_WRITE_MANUAL_REQUIRED_SUMMARY}（仍为 ${stateLabel}）`,
    action: LINEAR_WRITE_MANUAL_REQUIRED_ACTION,
    retryable: false,
  }
}

function normalizeStateName(value) {
  return String(value || "").trim().toLowerCase()
}
