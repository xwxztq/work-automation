const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "ALL_PROXY",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "APPDATA",
  "CARGO_HOME",
  "CODEX_HOME",
  "COLORTERM",
  "COMSPEC",
  "COREPACK_HOME",
  "CURL_CA_BUNDLE",
  "DEVELOPER_DIR",
  "FORCE_COLOR",
  "GOPATH",
  "GOROOT",
  "GRADLE_USER_HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "JAVA_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "M2_HOME",
  "NO_COLOR",
  "NO_PROXY",
  "NPM_CONFIG_PREFIX",
  "NODE_EXTRA_CA_CERTS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "PROGRAMDATA",
  "REQUESTS_CA_BUNDLE",
  "RUSTUP_HOME",
  "SDKROOT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "WSL_DISTRO_NAME",
  "WSLENV",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
])

const LINEAR_CREDENTIAL_NAME_PATTERN = /(?:LINEAR|MCP)/iu

/**
 * Keep only the environment required for Codex authentication, executable lookup,
 * common toolchains, locale, proxies, and custom certificate authorities.
 */
export function buildCodexProcessEnv(source = {}, options = {}) {
  const blockedNames = new Set(
    (options.blockedNames || [])
      .map((name) => normalizeEnvironmentName(name))
      .filter(Boolean),
  )
  const result = {}

  for (const [name, value] of Object.entries(source || {})) {
    if (value == null) continue
    const normalizedName = normalizeEnvironmentName(name)
    if (
      !normalizedName ||
      blockedNames.has(normalizedName) ||
      LINEAR_CREDENTIAL_NAME_PATTERN.test(normalizedName) ||
      (!ALLOWED_ENVIRONMENT_NAMES.has(normalizedName) && !normalizedName.startsWith("LC_"))
    ) {
      continue
    }
    result[name] = String(value)
  }

  return result
}

function normalizeEnvironmentName(name) {
  return String(name || "").trim().toUpperCase()
}
