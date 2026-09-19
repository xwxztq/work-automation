const REDACTED = "[REDACTED]"

export function redactDiagnostic(value, secrets = []) {
  const known = [...secrets, ...Object.entries(process.env)
    .filter(([key]) => /(?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION)/iu.test(key))
    .map(([, item]) => item)].filter((item) => typeof item === "string" && item.length >= 6)
  function visit(input) {
    if (typeof input === "string") {
      let text = input
      for (const secret of known) text = text.split(secret).join(REDACTED)
      return text
        .replace(/\blin_api_[A-Za-z0-9_-]+/gu, REDACTED)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `$1 ${REDACTED}`)
        .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password)["']?\s*[:=]\s*["']?)[^\s,"'<>]+/giu, `$1${REDACTED}`)
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, `$1${REDACTED}@`)
        .replace(/([?&](?:token|signature|key|secret|credential)=)[^\s&#]+/giu, `$1${REDACTED}`)
    }
    if (Array.isArray(input)) return input.map(visit)
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, /^(?:authorization|cookie|set-cookie|apiKey|accessToken|refreshToken|password)$/iu.test(key) ? REDACTED : visit(item)]))
    return input
  }
  return visit(value)
}
