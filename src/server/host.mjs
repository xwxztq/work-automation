export const RUNTIME_HOST_ENV = "LINEAR_AUTOMATION_HOST"

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"])
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

export function normalizeHost(host) {
  if (typeof host !== "string") {
    return ""
  }
  return host.trim()
}

export function isWildcardHost(host) {
  return WILDCARD_HOSTS.has(normalizeHost(host))
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(normalizeHost(host).toLowerCase())
}

export function validateHost(host) {
  const normalized = normalizeHost(host)
  if (!normalized) {
    return "host 必须填写。"
  }
  if (isWildcardHost(normalized)) {
    return "host 不能使用 0.0.0.0 或 ::，请填写本机具体局域网 IP。"
  }
  return ""
}

export function applyHostOverride(config, hostOverride) {
  const host = normalizeHost(hostOverride)
  return host ? { ...config, host } : config
}

