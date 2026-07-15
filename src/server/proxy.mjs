import { HttpsProxyAgent } from "https-proxy-agent"

export function resolveProxyUrl(target, env = process.env) {
  const url = target instanceof URL ? target : new URL(target)
  if (matchesNoProxy(url, env.no_proxy || env.NO_PROXY)) {
    return null
  }

  const candidates = url.protocol === "https:"
    ? [env.https_proxy, env.HTTPS_PROXY, env.all_proxy, env.ALL_PROXY]
    : [env.http_proxy, env.HTTP_PROXY, env.all_proxy, env.ALL_PROXY]

  return candidates.find((value) => String(value || "").trim())?.trim() || null
}

export function createProxyAgent(target, env = process.env) {
  const proxyUrl = resolveProxyUrl(target, env)
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
}

export function matchesNoProxy(target, noProxyValue) {
  const url = target instanceof URL ? target : new URL(target)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const port = url.port || (url.protocol === "https:" ? "443" : "80")

  return String(noProxyValue || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true
      const rule = parseNoProxyEntry(entry)
      if (!rule || (rule.port && rule.port !== port)) return false
      return hostname === rule.hostname || hostname.endsWith(`.${rule.hostname}`)
    })
}

function parseNoProxyEntry(entry) {
  let value = entry.trim().toLowerCase()
  if (!value) return null

  if (/^https?:\/\//.test(value)) {
    try {
      const url = new URL(value)
      return {
        hostname: url.hostname.replace(/^\[|\]$/g, "").replace(/^\*?\./, ""),
        port: url.port,
      }
    } catch {
      return null
    }
  }

  let hostname = value
  let port = ""
  const ipv6 = value.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (ipv6) {
    hostname = ipv6[1]
    port = ipv6[2] || ""
  } else if ((value.match(/:/g) || []).length === 1) {
    const separator = value.lastIndexOf(":")
    const candidatePort = value.slice(separator + 1)
    if (/^\d+$/.test(candidatePort)) {
      hostname = value.slice(0, separator)
      port = candidatePort
    }
  }

  hostname = hostname.replace(/^\*?\./, "")
  return hostname ? { hostname, port } : null
}
