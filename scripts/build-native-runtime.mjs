#!/usr/bin/env node
import fs, { createWriteStream } from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = parseArgs(process.argv.slice(2))
const targetPlatform = String(args.platform || process.platform)
const targetArch = String(args.arch || process.arch)
if (targetPlatform !== "darwin") {
  throw new Error("阶段一原生发布包目前只支持 darwin。")
}
if (!new Set(["arm64", "x64"]).has(targetArch)) {
  throw new Error(`不支持的 macOS 架构: ${targetArch}`)
}

const packageJson = JSON.parse(await fsp.readFile(path.join(projectRoot, "package.json"), "utf8"))
const createdAt = new Date().toISOString()
const buildId = createdAt.replace(/[-:.TZ]/g, "")
const releaseId = `${packageJson.version}-${targetPlatform}-${targetArch}-${buildId}`
const outputDir = path.resolve(
  projectRoot,
  String(args.output || path.join("artifacts", "native", `work-automation-${targetPlatform}-${targetArch}`)),
)

await fsp.rm(outputDir, { recursive: true, force: true })
await fsp.mkdir(outputDir, { recursive: true })

for (const relativePath of [
  "dist",
  "src/server",
  "prompts",
  "docs",
  "README.md",
  "config.example.json",
  "package.json",
]) {
  await copyRequired(relativePath)
}

const nodeRuntime = args.localNode || args.nodeBin
  ? await installLocalNodeRuntime(args.nodeBin)
  : await installOfficialNodeRuntime({
      version: String(args.nodeVersion || process.versions.node).replace(/^v/, ""),
      platform: targetPlatform,
      arch: targetArch,
      baseUrl: String(args.nodeBaseUrl || "https://nodejs.org/dist"),
    })

await copyRuntimeDependencies(["https-proxy-agent"])
await writeLaunchers()

const manifest = {
  schemaVersion: 1,
  name: packageJson.name,
  appVersion: packageJson.version,
  releaseId,
  buildId,
  createdAt,
  platform: targetPlatform,
  arch: targetArch,
  nodeRuntime,
}
await fsp.writeFile(
  path.join(outputDir, "native-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
)

console.log(`原生发布包已生成: ${outputDir}`)
if (!nodeRuntime.portable) {
  console.warn("当前包使用本机 Node 二进制，仅用于本机冒烟测试；正式发布请使用默认的校验下载模式。")
}

async function copyRequired(relativePath) {
  const sourcePath = path.join(projectRoot, relativePath)
  const targetPath = path.join(outputDir, relativePath)
  try {
    await fsp.access(sourcePath)
  } catch {
    throw new Error(`原生发布包缺少构建输入: ${sourcePath}`)
  }
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  await fsp.cp(sourcePath, targetPath, {
    recursive: true,
    dereference: true,
    filter: (candidate) => !candidate.endsWith(".test.mjs"),
  })
}

async function installLocalNodeRuntime(nodeBinOption) {
  const sourcePath = await fsp.realpath(
    nodeBinOption ? path.resolve(projectRoot, String(nodeBinOption)) : process.execPath,
  )
  const targetPath = path.join(outputDir, "runtime", "bin", "node")
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  await fsp.copyFile(sourcePath, targetPath)
  await fsp.chmod(targetPath, 0o755)
  const nodeRootDir = path.dirname(path.dirname(sourcePath))
  await copyLocalNodeLibraries(nodeRootDir)
  await copyNodeLicense(nodeRootDir)
  return {
    version: process.versions.node,
    source: "local-binary",
    portable: false,
  }
}

async function copyLocalNodeLibraries(nodeRootDir) {
  const sourceLibDir = path.join(nodeRootDir, "lib")
  let entries = []
  try {
    entries = await fsp.readdir(sourceLibDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") {
      return
    }
    throw error
  }

  const dylibs = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".dylib"))
  if (!dylibs.length) {
    return
  }
  const targetLibDir = path.join(outputDir, "runtime", "lib")
  await fsp.mkdir(targetLibDir, { recursive: true })
  for (const entry of dylibs) {
    await fsp.copyFile(
      path.join(sourceLibDir, entry.name),
      path.join(targetLibDir, entry.name),
    )
  }
}

async function installOfficialNodeRuntime({ version, platform, arch, baseUrl }) {
  const distributionName = `node-v${version}-${platform}-${arch}`
  const archiveName = `${distributionName}.tar.gz`
  const releaseUrl = `${baseUrl.replace(/\/$/, "")}/v${version}`
  const checksumUrl = `${releaseUrl}/SHASUMS256.txt`
  const archiveUrl = `${releaseUrl}/${archiveName}`
  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), "work-automation-node-"))
  const archivePath = path.join(temporaryDir, archiveName)
  const extractedDir = path.join(temporaryDir, "extracted")

  try {
    const checksumResponse = await fetch(checksumUrl)
    if (!checksumResponse.ok) {
      throw new Error(`无法下载 Node 校验文件: HTTP ${checksumResponse.status}`)
    }
    const expectedChecksum = checksumFor(
      await checksumResponse.text(),
      archiveName,
    )
    if (!expectedChecksum) {
      throw new Error(`Node 校验文件中没有 ${archiveName}`)
    }

    const archiveResponse = await fetch(archiveUrl)
    if (!archiveResponse.ok || !archiveResponse.body) {
      throw new Error(`无法下载 Node 运行时: HTTP ${archiveResponse.status}`)
    }
    await pipeline(
      Readable.fromWeb(archiveResponse.body),
      createWriteStream(archivePath, { mode: 0o600 }),
    )
    const actualChecksum = await sha256File(archivePath)
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Node 运行时 SHA-256 校验失败: ${archiveName}`)
    }

    await fsp.mkdir(extractedDir, { recursive: true })
    const tarResult = spawnSync("tar", ["-xzf", archivePath, "-C", extractedDir], {
      encoding: "utf8",
    })
    if (tarResult.status !== 0) {
      throw new Error(`解压 Node 运行时失败: ${String(tarResult.stderr || "").trim()}`)
    }

    const distributionDir = path.join(extractedDir, distributionName)
    const targetNodePath = path.join(outputDir, "runtime", "bin", "node")
    await fsp.mkdir(path.dirname(targetNodePath), { recursive: true })
    await fsp.copyFile(path.join(distributionDir, "bin", "node"), targetNodePath)
    await fsp.chmod(targetNodePath, 0o755)
    await fsp.copyFile(
      path.join(distributionDir, "LICENSE"),
      path.join(outputDir, "runtime", "LICENSE.node.txt"),
    )

    return {
      version,
      source: archiveUrl,
      sha256: actualChecksum,
      portable: true,
    }
  } finally {
    await fsp.rm(temporaryDir, { recursive: true, force: true })
  }
}

async function copyRuntimeDependencies(packageNames) {
  const rootRequire = createRequire(path.join(projectRoot, "package.json"))
  const copied = new Set()
  for (const packageName of packageNames) {
    const packageJsonPath = rootRequire.resolve(`${packageName}/package.json`)
    await copyRuntimePackage(packageName, packageJsonPath, copied)
  }
}

async function copyRuntimePackage(packageName, packageJsonPath, copied) {
  const metadata = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"))
  const copyKey = `${packageName}@${metadata.version || packageJsonPath}`
  if (copied.has(copyKey)) {
    return
  }
  copied.add(copyKey)

  const packageDir = path.dirname(packageJsonPath)
  const targetDir = path.join(outputDir, "node_modules", ...packageName.split("/"))
  await fsp.mkdir(path.dirname(targetDir), { recursive: true })
  await fsp.cp(packageDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => path.basename(sourcePath) !== "node_modules",
  })

  const packageRequire = createRequire(packageJsonPath)
  const dependencies = {
    ...(metadata.dependencies || {}),
    ...(metadata.optionalDependencies || {}),
  }
  for (const dependencyName of Object.keys(dependencies)) {
    let dependencyPackageJson
    try {
      dependencyPackageJson = packageRequire.resolve(`${dependencyName}/package.json`)
    } catch (error) {
      if (metadata.optionalDependencies?.[dependencyName]) {
        continue
      }
      throw error
    }
    await copyRuntimePackage(dependencyName, dependencyPackageJson, copied)
  }
}

async function writeLaunchers() {
  const binDir = path.join(outputDir, "bin")
  await fsp.mkdir(binDir, { recursive: true })
  const cli = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/../runtime/bin/node" "$SCRIPT_DIR/../src/server/native-service-cli.mjs" "$@"
`
  const installCommand = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/bin/wauto" install
`
  const installGuide = `Work Automation macOS 安装说明

1. 双击 install.command，或在终端运行 ./install.command。
2. 浏览器会打开本机首次配置页面。
3. 填写 Linear API key，确认自动检测到的 Codex 路径，然后保存。

服务管理命令位于 bin/wauto：
  status / start / stop / open / uninstall

uninstall 只移除 LaunchAgent 注册，保留用户配置和运行记录。
`
  await fsp.writeFile(path.join(binDir, "wauto"), cli, { mode: 0o755 })
  await fsp.writeFile(path.join(outputDir, "install.command"), installCommand, { mode: 0o755 })
  await fsp.writeFile(path.join(outputDir, "README-INSTALL.txt"), installGuide)
}

async function copyNodeLicense(nodeRootDir) {
  for (const candidate of [
    path.join(nodeRootDir, "LICENSE"),
    path.join(nodeRootDir, "LICENSE.txt"),
  ]) {
    if (fs.existsSync(candidate)) {
      await fsp.copyFile(candidate, path.join(outputDir, "runtime", "LICENSE.node.txt"))
      return
    }
  }
}

function checksumFor(content, archiveName) {
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match?.[2] === archiveName) {
      return match[1]
    }
  }
  return null
}

async function sha256File(filePath) {
  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest("hex")
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      throw new Error(`未知参数: ${arg}`)
    }
    const option = arg.slice(2)
    const equalsIndex = option.indexOf("=")
    const rawKey = equalsIndex === -1 ? option : option.slice(0, equalsIndex)
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    if (equalsIndex !== -1) {
      parsed[key] = option.slice(equalsIndex + 1)
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      parsed[key] = true
      continue
    }
    parsed[key] = next
    index += 1
  }
  return parsed
}
