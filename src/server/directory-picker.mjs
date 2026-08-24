import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import { resolveExecutable } from "./executable.mjs"

const execFileAsync = promisify(execFile)

export class DirectoryPickerUnavailableError extends Error {
  constructor(message = "当前运行环境不支持交互式目录选择。") {
    super(message)
    this.name = "DirectoryPickerUnavailableError"
    this.code = "DIRECTORY_PICKER_UNAVAILABLE"
  }
}

export function createDirectoryPicker({
  platform = process.platform,
  env = process.env,
  resolve = resolveExecutable,
  run = runExecutable,
  validate = validateSelectedDirectory,
} = {}) {
  async function detectPicker() {
    if (platform === "darwin") {
      const executable = await resolve("/usr/bin/osascript", {
        path: String(env.PATH || ""),
      })
      return executable ? { provider: "osascript", executable } : null
    }

    if (platform !== "linux" || !hasGraphicalSession(env)) {
      return null
    }

    for (const provider of ["zenity", "kdialog"]) {
      const executable = await resolve(provider, {
        path: String(env.PATH || ""),
      })
      if (executable) {
        return { provider, executable }
      }
    }
    return null
  }

  async function getCapability() {
    return { available: Boolean(await detectPicker()) }
  }

  async function pickDirectory() {
    const picker = await detectPicker()
    if (!picker) {
      throw new DirectoryPickerUnavailableError()
    }

    let stdout
    try {
      const result = await run(picker.executable, pickerArguments(picker.provider))
      stdout = result?.stdout ?? ""
    } catch (error) {
      if (isCancellation(error, picker.provider)) {
        return { status: "canceled" }
      }
      throw new Error(directoryPickerFailureMessage(error), { cause: error })
    }

    const selectedPath = String(stdout).replace(/(?:\r?\n)+$/u, "")
    if (!selectedPath) {
      throw new Error("目录选择器没有返回路径。")
    }
    return {
      status: "selected",
      path: await validate(selectedPath),
    }
  }

  return { getCapability, pickDirectory }
}

function hasGraphicalSession(env) {
  return Boolean(String(env.DISPLAY || "").trim() || String(env.WAYLAND_DISPLAY || "").trim())
}

function pickerArguments(provider) {
  if (provider === "osascript") {
    return [
      "-e",
      'POSIX path of (choose folder with prompt "选择仓库目录")',
    ]
  }
  if (provider === "zenity") {
    return ["--file-selection", "--directory", "--title=选择仓库目录"]
  }
  return ["--title", "选择仓库目录", "--getexistingdirectory"]
}

function isCancellation(error, provider) {
  const exitCode = Number(error?.code)
  if (provider === "osascript") {
    return exitCode === 1 && /\(-128\)|user canceled/iu.test(String(error?.stderr || error?.message || ""))
  }
  return exitCode === 1 && !String(error?.stderr || "").trim()
}

function directoryPickerFailureMessage(error) {
  const detail = String(error?.stderr || error?.message || "").trim()
  return detail ? `目录选择器执行失败: ${detail}` : "目录选择器执行失败。"
}

async function runExecutable(executable, args) {
  return execFileAsync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
  })
}

async function validateSelectedDirectory(selectedPath) {
  if (!path.isAbsolute(selectedPath)) {
    throw new Error("目录选择器返回的路径不是绝对路径。")
  }
  const normalizedPath = path.resolve(selectedPath)
  let stats
  try {
    stats = await fs.stat(normalizedPath)
    await fs.access(normalizedPath, constants.R_OK)
  } catch (error) {
    throw new Error(`选择的目录不可读: ${normalizedPath}`, { cause: error })
  }
  if (!stats.isDirectory()) {
    throw new Error(`选择的路径不是目录: ${normalizedPath}`)
  }
  return normalizedPath
}
