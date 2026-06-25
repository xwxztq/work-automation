import path from "node:path"
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

  const searchPath = String(options.path || process.env.PATH || "")
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue
    const candidate = path.join(entry, command)
    if (await isExecutable(candidate)) {
      return candidate
    }
  }
  return null
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
