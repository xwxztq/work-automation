import fs from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"

export const RUNTIME_HOME_ENV = "WORK_AUTOMATION_HOME"
export const APP_SUPPORT_DIRECTORY = "WorkAutomation"

export function defaultApplicationSupportRoot(options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const homeDir = options.homeDir || os.homedir()

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", APP_SUPPORT_DIRECTORY)
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local")
    return path.join(localAppData, APP_SUPPORT_DIRECTORY)
  }

  const dataHome = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share")
  return path.join(dataHome, "work-automation")
}

export function defaultRuntimeRoot(options = {}) {
  return path.join(defaultApplicationSupportRoot(options), "data")
}

export function resolveRuntimePaths({
  appRootDir,
  launchCwd = process.cwd(),
  runtimeRoot,
  configPath,
  env = process.env,
  platform = process.platform,
  homeDir,
} = {}) {
  if (!appRootDir) {
    throw new Error("缺少 appRootDir，无法解析 Work Automation 运行目录。")
  }

  const selectedRuntimeRoot =
    String(runtimeRoot || env[RUNTIME_HOME_ENV] || "").trim() ||
    defaultRuntimeRoot({ platform, env, homeDir })
  const runtimeRootDir = path.isAbsolute(selectedRuntimeRoot)
    ? path.normalize(selectedRuntimeRoot)
    : path.resolve(launchCwd, selectedRuntimeRoot)
  const selectedConfigPath = String(configPath || "config.json").trim() || "config.json"

  return {
    appRootDir: path.resolve(appRootDir),
    runtimeRootDir,
    configPath: path.isAbsolute(selectedConfigPath)
      ? path.normalize(selectedConfigPath)
      : path.resolve(runtimeRootDir, selectedConfigPath),
    promptsDir: path.join(runtimeRootDir, "prompts"),
    bundledPromptsDir: path.join(path.resolve(appRootDir), "prompts"),
    stateDir: path.join(runtimeRootDir, ".linear-automation"),
    logsDir: path.join(runtimeRootDir, "logs"),
  }
}

export async function ensureRuntimeLayout(paths) {
  await fs.mkdir(paths.runtimeRootDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.logsDir, { recursive: true, mode: 0o700 })

  if (samePath(paths.bundledPromptsDir, paths.promptsDir)) {
    return paths
  }

  await copyMissingTree(paths.bundledPromptsDir, paths.promptsDir)
  return paths
}

async function copyMissingTree(sourceDir, targetDir) {
  let entries
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`内置提示词目录不存在: ${sourceDir}`)
    }
    throw error
  }

  await fs.mkdir(targetDir, { recursive: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyMissingTree(sourcePath, targetPath)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL).catch((error) => {
      if (error?.code !== "EEXIST") {
        throw error
      }
    })
  }
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right)
}
