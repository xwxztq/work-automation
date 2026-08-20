#!/usr/bin/env node
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { loadConfig } from "./config.mjs"
import {
  NATIVE_DEFAULT_PORT,
  renderLaunchAgentPlist,
  resolveNativeServicePaths,
  writeLaunchAgentPlist,
} from "./native-service.mjs"

const sourcePackageRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const serverEntryPath = path.join(sourcePackageRootDir, "src", "server", "index.mjs")

await main()

async function main() {
  const parsed = parseCommand(process.argv.slice(2))

  if (parsed.command === "help" || parsed.command === "service-help") {
    printHelp(parsed.command === "service-help")
    return
  }
  if (parsed.command === "version") {
    const metadata = await readPackageMetadata(sourcePackageRootDir)
    console.log(`${metadata.name} ${metadata.version}`)
    return
  }
  if (new Set(["serve", "once", "validate-config"]).has(parsed.command)) {
    await runServerCommand(parsed.command, parsed.args)
    return
  }
  if (!new Set(["install", "start", "stop", "status", "open", "uninstall"]).has(parsed.command)) {
    console.error(`未知命令: ${parsed.command}`)
    printHelp(false)
    process.exitCode = 1
    return
  }
  if (process.platform !== "darwin") {
    console.error("npm 包可以使用 wauto serve 前台运行；后台服务注册目前只支持 macOS。")
    process.exitCode = 1
    return
  }

  await runMacServiceCommand(parsed.command)
}

async function runServerCommand(command, args) {
  process.argv = [process.execPath, serverEntryPath, command, ...args]
  await import("./index.mjs")
}

async function runMacServiceCommand(command) {
  const distribution = await readDistribution(sourcePackageRootDir)
  const sourcePaths = resolveNativeServicePaths({
    bundleRootDir: sourcePackageRootDir,
    releaseId: distribution.releaseId,
  })
  const uid = typeof process.getuid === "function" ? process.getuid() : null
  if (uid === null) {
    throw new Error("无法取得当前 macOS 用户 ID。")
  }
  const launchDomain = `gui/${uid}`
  const serviceTarget = `${launchDomain}/${sourcePaths.label}`

  if (command === "install") {
    await install({ distribution, sourcePaths, launchDomain, serviceTarget })
  } else if (command === "start") {
    runLaunchctl(["bootout", serviceTarget], { allowFailure: true })
    runLaunchctl(["bootstrap", launchDomain, sourcePaths.plistPath])
    runLaunchctl(["enable", serviceTarget], { allowFailure: true })
    runLaunchctl(["kickstart", "-k", serviceTarget])
    console.log("Work Automation 已启动。")
  } else if (command === "stop") {
    runLaunchctl(["bootout", launchDomain, sourcePaths.plistPath], { allowFailure: true })
    console.log("Work Automation 已停止。")
  } else if (command === "status") {
    const result = runLaunchctl(["print", serviceTarget], { allowFailure: true, inherit: true })
    process.exitCode = result.status === 0 ? 0 : 1
  } else if (command === "open") {
    await openDashboard(sourcePaths.runtimeRootDir)
  } else if (command === "uninstall") {
    runLaunchctl(["bootout", launchDomain, sourcePaths.plistPath], { allowFailure: true })
    await fs.rm(sourcePaths.plistPath, { force: true })
    const retained = distribution.kind === "native"
      ? "用户配置、运行记录和已安装程序仍保留。"
      : "用户配置和运行记录仍保留。"
    console.log(`后台服务注册已移除。${retained}`)
    console.log(`用户数据目录: ${sourcePaths.runtimeRootDir}`)
  }
}

async function install({ distribution, sourcePaths, launchDomain, serviceTarget }) {
  await ensurePrivateDirectory(sourcePaths.appSupportRoot)
  await ensurePrivateDirectory(sourcePaths.runtimeRootDir)
  await ensurePrivateDirectory(sourcePaths.logsDir)

  let applicationRootDir = sourcePackageRootDir
  let nodePath = process.execPath
  let installedPaths = sourcePaths

  if (distribution.kind === "native") {
    await ensurePrivateDirectory(sourcePaths.appVersionsDir)
    if (path.resolve(sourcePackageRootDir) !== path.resolve(sourcePaths.appInstallDir)) {
      await installBundle(sourcePackageRootDir, sourcePaths.appInstallDir, distribution.markerFile)
    }
    applicationRootDir = sourcePaths.appInstallDir
    nodePath = path.join(applicationRootDir, "runtime", "bin", "node")
    installedPaths = resolveNativeServicePaths({
      bundleRootDir: applicationRootDir,
      releaseId: distribution.releaseId,
    })
  }

  const plist = renderLaunchAgentPlist({
    bundleRootDir: applicationRootDir,
    nodePath,
    serverEntryPath: path.join(applicationRootDir, "src", "server", "index.mjs"),
    runtimeRootDir: installedPaths.runtimeRootDir,
    configPath: installedPaths.configPath,
    stdoutPath: installedPaths.stdoutPath,
    stderrPath: installedPaths.stderrPath,
  })
  await writeLaunchAgentPlist(installedPaths.plistPath, plist)

  runLaunchctl(["bootout", serviceTarget], { allowFailure: true })
  runLaunchctl(["bootstrap", launchDomain, installedPaths.plistPath])
  runLaunchctl(["enable", serviceTarget], { allowFailure: true })
  runLaunchctl(["kickstart", "-k", serviceTarget])

  if (distribution.kind === "native") {
    console.log(`Work Automation 已安装到 ${applicationRootDir}`)
  } else {
    console.log(`Work Automation 已从 npm 包注册: ${applicationRootDir}`)
    console.log(`Node: ${nodePath}`)
  }
  console.log(`用户数据保存在 ${installedPaths.runtimeRootDir}`)
  await openDashboard(installedPaths.runtimeRootDir)
}

async function installBundle(sourceDir, targetDir, markerFile) {
  try {
    await fs.access(path.join(targetDir, markerFile))
    return
  } catch {
    // Continue with a fresh versioned install.
  }

  const stagingDir = `${targetDir}.installing-${process.pid}`
  await fs.rm(stagingDir, { recursive: true, force: true })
  try {
    await fs.cp(sourceDir, stagingDir, { recursive: true, dereference: true })
    await fs.rename(stagingDir, targetDir)
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true })
  }
}

async function openDashboard(runtimeRootDir) {
  const config = await loadConfig(path.join(runtimeRootDir, "config.json"), runtimeRootDir)
  const port = Number(config.port || NATIVE_DEFAULT_PORT)
  const url = `http://127.0.0.1:${port}`
  await waitForHttp(url, 8_000).catch(() => {})
  const child = spawn("/usr/bin/open", [url], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  console.log(`管理界面: ${url}`)
}

function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume()
        resolve()
      })
      request.setTimeout(500, () => request.destroy())
      request.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`服务未在 ${timeoutMs}ms 内响应。`))
          return
        }
        setTimeout(check, 200)
      })
    }
    check()
  })
}

function runLaunchctl(args, options = {}) {
  const result = spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  })
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim()
    throw new Error(`launchctl ${args[0]} 失败${detail ? `: ${detail}` : ""}`)
  }
  return result
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
}

async function readDistribution(packageRootDir) {
  const nativeManifest = await readOptionalJson(path.join(packageRootDir, "native-manifest.json"))
  if (nativeManifest) {
    return {
      kind: "native",
      releaseId: nativeManifest.releaseId,
      markerFile: "native-manifest.json",
    }
  }

  const metadata = await readPackageMetadata(packageRootDir)
  return {
    kind: "npm",
    releaseId: `npm-${metadata.version}`,
    markerFile: "package.json",
  }
}

async function readPackageMetadata(packageRootDir) {
  const metadata = await readJson(path.join(packageRootDir, "package.json"))
  if (!metadata.name || !metadata.version) {
    throw new Error("package.json 缺少 name 或 version。")
  }
  return metadata
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }
    throw error
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"))
}

function parseCommand(argv) {
  if (!argv.length || new Set(["help", "--help", "-h"]).has(argv[0])) {
    return { command: "help", args: [] }
  }
  if (new Set(["version", "--version", "-v"]).has(argv[0])) {
    return { command: "version", args: [] }
  }
  if (argv[0] === "service") {
    if (!argv[1] || new Set(["help", "--help", "-h"]).has(argv[1])) {
      return { command: "service-help", args: [] }
    }
    return { command: argv[1], args: argv.slice(2) }
  }
  if (argv[0] === "setup") {
    return { command: "install", args: argv.slice(1) }
  }
  if (argv[0] === "validate") {
    return { command: "validate-config", args: argv.slice(1) }
  }
  return { command: argv[0], args: argv.slice(1) }
}

function printHelp(serviceOnly) {
  if (serviceOnly) {
    console.log(`Work Automation macOS 后台服务

用法:
  wauto service install    注册并启动后台服务
  wauto service start      启动服务
  wauto service stop       停止服务
  wauto service status     查看服务状态
  wauto service open       打开管理界面
  wauto service uninstall  移除服务注册并保留用户数据
`)
    return
  }

  console.log(`Work Automation

用法:
  wauto setup              macOS 首次安装，注册服务并打开配置页面
  wauto open               打开本机管理界面
  wauto serve [选项]       在前台运行服务，支持 macOS/Windows/Linux
  wauto once [选项]        执行一轮任务
  wauto validate [选项]    校验配置
  wauto service <命令>     管理 macOS 后台服务
  wauto --version          显示版本

兼容原生命令: install / start / stop / status / uninstall
`)
}
