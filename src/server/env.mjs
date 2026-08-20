import fs from "node:fs/promises"
import path from "node:path"

export const DEFAULT_LOCAL_ENV_FILES = [".env.local", ".env"]
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function loadLocalEnv(rootDir = process.cwd(), options = {}) {
  const env = options.env || process.env
  const files = options.files || DEFAULT_LOCAL_ENV_FILES
  const loaded = []

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.resolve(rootDir, file)
    let content
    try {
      content = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue
      }
      throw error
    }

    const parsed = parseEnvContent(content)
    const applied = []
    const skipped = []
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) {
        env[key] = value
        applied.push(key)
      } else {
        skipped.push(key)
      }
    }
    loaded.push({
      file: path.relative(rootDir, filePath) || filePath,
      applied,
      skipped,
    })
  }

  return loaded
}

export function parseEnvContent(content) {
  const parsed = {}
  const normalized = content.replace(/^\uFEFF/, "")

  for (const line of normalized.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) {
      continue
    }

    const [, key, rawValue] = match
    parsed[key] = parseEnvValue(rawValue)
  }

  return parsed
}

export async function writeLocalEnvValue(
  rootDir,
  key,
  value,
  options = {},
) {
  if (!ENV_KEY_PATTERN.test(String(key || ""))) {
    throw new Error(`无效的环境变量名: ${key}`)
  }

  const file = options.file || ".env.local"
  const filePath = path.isAbsolute(file) ? file : path.resolve(rootDir, file)
  let content = ""
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error
    }
  }

  const replacement = `${key}=${serializeEnvValue(value)}`
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)
  const assignment = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=`)
  const nextLines = []
  let replaced = false
  for (const line of lines) {
    if (!assignment.test(line.trim())) {
      nextLines.push(line)
      continue
    }
    if (!replaced) {
      nextLines.push(replacement)
      replaced = true
    }
  }
  if (!replaced) {
    while (nextLines.at(-1) === "") {
      nextLines.pop()
    }
    nextLines.push(replacement)
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, `${nextLines.join("\n")}\n`, { mode: 0o600 })
  await fs.rename(temporaryPath, filePath)
  await fs.chmod(filePath, 0o600)
  return filePath
}

function parseEnvValue(rawValue) {
  const value = rawValue.trim()
  if (!value) {
    return ""
  }

  const quote = value[0]
  if (quote === "\"" || quote === "'" || quote === "`") {
    return parseQuotedEnvValue(value, quote)
  }

  return stripInlineComment(value).trim()
}

function parseQuotedEnvValue(value, quote) {
  let escaped = false
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]
    if (quote === "\"" && char === "\\" && !escaped) {
      escaped = true
      continue
    }
    if (char === quote && !escaped) {
      const unquoted = value.slice(1, index)
      return quote === "\"" ? unescapeDoubleQuotedValue(unquoted) : unquoted
    }
    escaped = false
  }
  return value
}

function stripInlineComment(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index)
    }
  }
  return value
}

function unescapeDoubleQuotedValue(value) {
  return value.replace(/\\([nrt"\\])/g, (_, char) => {
    if (char === "n") return "\n"
    if (char === "r") return "\r"
    if (char === "t") return "\t"
    return char
  })
}

function serializeEnvValue(value) {
  return `"${String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"')}"`
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
