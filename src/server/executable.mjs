import path from "node:path"
import os from "node:os"
import { access } from "node:fs/promises"
import { constants } from "node:fs"

export async function resolveExecutable(command, options = {}) {
  const cwd = options.cwd || process.cwd()
  if (!command?.trim()) {
    return null
  }

  if (isPathLike(command)) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command)
    return (await isExecutable(candidate)) ? candidate : null
  }

  const searchPath = String(options.path ?? process.env.PATH ?? "")
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue
    const candidate = path.join(entry, command)
    if (await isExecutable(candidate)) {
      return candidate
    }
  }
  return null
}

export async function resolveCodexExecutable(command = "codex", options = {}) {
  const configured = String(command || "codex").trim() || "codex"
  const configuredExecutable = await resolveExecutable(configured, options)
  if (configuredExecutable) {
    return configuredExecutable
  }

  if (options.fallbackKnownLocations === false) {
    return null
  }

  for (const candidate of knownCodexExecutableCandidates(options)) {
    if (await isExecutable(candidate)) {
      return candidate
    }
  }
  return null
}

export function knownCodexExecutableCandidates(options = {}) {
  if (Array.isArray(options.candidates)) {
    return uniquePaths(options.candidates)
  }

  const platform = options.platform || process.platform
  const homeDir = options.homeDir || os.homedir()
  const env = options.env || process.env

  if (platform === "darwin") {
    return uniquePaths([
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(homeDir, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      path.join(homeDir, ".local", "bin", "codex"),
      path.join(homeDir, ".bun", "bin", "codex"),
    ])
  }

  if (platform === "win32") {
    return uniquePaths([
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "codex", "codex.exe"),
      env.APPDATA && path.join(env.APPDATA, "npm", "codex.cmd"),
      path.join(homeDir, ".bun", "bin", "codex.exe"),
      path.join(homeDir, ".local", "bin", "codex.exe"),
    ])
  }

  return uniquePaths([
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    path.join(homeDir, ".local", "bin", "codex"),
    path.join(homeDir, ".bun", "bin", "codex"),
  ])
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isPathLike(command) {
  return command.includes("/") || command.includes("\\")
}

function uniquePaths(candidates) {
  return [...new Set(candidates.filter(Boolean).map((candidate) => path.normalize(candidate)))]
}
