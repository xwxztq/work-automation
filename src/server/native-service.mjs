import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { defaultApplicationSupportRoot } from "./app-paths.mjs"

export const NATIVE_SERVICE_LABEL = "com.workautomation.agent"
export const NATIVE_DEFAULT_PORT = 4378

export function resolveNativeServicePaths({
  bundleRootDir,
  releaseId,
  homeDir = os.homedir(),
  appSupportRoot = defaultApplicationSupportRoot({ platform: "darwin", homeDir }),
  label = NATIVE_SERVICE_LABEL,
} = {}) {
  if (!bundleRootDir) {
    throw new Error("缺少 bundleRootDir，无法生成 macOS 服务路径。")
  }
  const safeReleaseId = sanitizeReleaseId(releaseId || "development")
  const appInstallDir = path.join(appSupportRoot, "app", safeReleaseId)
  const runtimeRootDir = path.join(appSupportRoot, "data")

  return {
    label,
    appSupportRoot,
    appVersionsDir: path.join(appSupportRoot, "app"),
    sourceBundleRootDir: path.resolve(bundleRootDir),
    appInstallDir,
    runtimeRootDir,
    configPath: path.join(runtimeRootDir, "config.json"),
    logsDir: path.join(runtimeRootDir, "logs"),
    stdoutPath: path.join(runtimeRootDir, "logs", "service.stdout.log"),
    stderrPath: path.join(runtimeRootDir, "logs", "service.stderr.log"),
    launchAgentsDir: path.join(homeDir, "Library", "LaunchAgents"),
    plistPath: path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`),
  }
}

export function renderLaunchAgentPlist({
  label = NATIVE_SERVICE_LABEL,
  bundleRootDir,
  nodePath: configuredNodePath,
  serverEntryPath: configuredServerEntryPath,
  runtimeRootDir,
  configPath = path.join(runtimeRootDir || "", "config.json"),
  stdoutPath = path.join(runtimeRootDir || "", "logs", "service.stdout.log"),
  stderrPath = path.join(runtimeRootDir || "", "logs", "service.stderr.log"),
  homeDir = os.homedir(),
} = {}) {
  const nodePath = configuredNodePath || path.join(bundleRootDir || "", "runtime", "bin", "node")
  const serverEntryPath =
    configuredServerEntryPath || path.join(bundleRootDir || "", "src", "server", "index.mjs")
  for (const [name, value] of Object.entries({
    bundleRootDir,
    nodePath,
    serverEntryPath,
    runtimeRootDir,
    configPath,
    stdoutPath,
    stderrPath,
  })) {
    if (!value || !path.isAbsolute(value)) {
      throw new Error(`${name} 必须是绝对路径。`)
    }
  }

  const servicePath = [
    path.dirname(nodePath),
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".bun", "bin"),
    path.join(homeDir, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(serverEntryPath)}</string>
    <string>--config</string>
    <string>${escapeXml(configPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(bundleRootDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORK_AUTOMATION_HOME</key>
    <string>${escapeXml(runtimeRootDir)}</string>
    <key>HOME</key>
    <string>${escapeXml(homeDir)}</string>
    <key>PATH</key>
    <string>${escapeXml(servicePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`
}

export async function writeLaunchAgentPlist(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, content, { mode: 0o600 })
  await fs.rename(temporaryPath, filePath)
  await fs.chmod(filePath, 0o600)
  return filePath
}

function sanitizeReleaseId(value) {
  const normalized = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-")
  return normalized || "development"
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
