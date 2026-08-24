import fs from "node:fs/promises"
import path from "node:path"

const LAUNCHER_PROFILE_NAME = "work-automation-launcher"
const ENV_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "*.env",
  "*.env.*",
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/*.env.*",
]
const DIRECTORY_ENVIRONMENT_NAMES = [
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "COREPACK_HOME",
  "DEVELOPER_DIR",
  "GOROOT",
  "JAVA_HOME",
  "M2_HOME",
  "NPM_CONFIG_PREFIX",
  "PNPM_HOME",
  "RUSTUP_HOME",
  "SDKROOT",
]
const FILE_ENVIRONMENT_NAMES = [
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]

export function buildCodexPermissionBoundary({
  stage,
  cwd,
  projectPath,
  runtimeRoot,
  runDir,
  finalPath,
  credentialFilePaths = [],
  runtimeReadPaths = [],
  launcherReadPaths = [],
  runtimeWritePaths = [],
}) {
  const resolvedCwd = path.resolve(cwd)
  const resolvedProjectPath = path.resolve(projectPath || cwd)
  const resolvedRuntimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : null
  const resolvedRunDir = path.resolve(runDir)
  const workspaceAccess = stage === "part2" ? "write" : "read"
  const profileWorkspaceRoots =
    resolvedProjectPath === resolvedCwd
      ? undefined
      : { [resolvedProjectPath]: true }
  const workspaceRules = {
    ".": workspaceAccess,
    ...Object.fromEntries(ENV_FILE_PATTERNS.map((pattern) => [pattern, "deny"])),
  }
  const runRules = buildRunRules({
    stage,
    runDir: resolvedRunDir,
    finalPath,
  })

  const launcherFilesystem = {
    ":root": "deny",
    ":minimal": "read",
    ...platformRuntimeRules(),
    ":tmpdir": "write",
    ":slash_tmp": "deny",
    ":workspace_roots": workspaceRules,
  }
  addReadPaths(launcherFilesystem, runtimeReadPaths)
  addWritePaths(launcherFilesystem, runtimeWritePaths)
  addRuntimeIsolationRules(launcherFilesystem, {
    cwd: resolvedCwd,
    projectPath: resolvedProjectPath,
    runtimeRoot: resolvedRuntimeRoot,
    runDir: resolvedRunDir,
    runRules,
  })
  for (const filePath of credentialFilePaths) {
    if (filePath) {
      launcherFilesystem[path.resolve(filePath)] = "deny"
    }
  }
  addReadPaths(launcherFilesystem, launcherReadPaths)

  const launcherProfile = compactProfile({
    description: "Work Automation externally enforced Codex boundary.",
    workspace_roots: profileWorkspaceRoots,
    filesystem: launcherFilesystem,
    network: { enabled: true },
  })

  return {
    launcher: {
      name: LAUNCHER_PROFILE_NAME,
      configArgs: [
        "-c",
        `permissions.${LAUNCHER_PROFILE_NAME}=${tomlValue(launcherProfile)}`,
        "-c",
        "mcp_servers={}",
      ],
    },
  }
}

export function buildCodexRuntimeReadPaths(environment = {}) {
  const values = []
  const homePaths = [environment.HOME, environment.USERPROFILE]
    .map((value) => String(value || "").trim())
    .filter((value) => value && path.isAbsolute(value))
    .map((value) => path.resolve(value))
  const addPath = (value) => {
    if (!value || !path.isAbsolute(value)) return
    const resolved = path.resolve(value)
    if (
      resolved === path.parse(resolved).root ||
      homePaths.some((homePath) => isSameOrDescendant(homePath, resolved))
    ) {
      return
    }
    values.push(resolved)
  }
  for (const entry of String(environment.PATH || "").split(path.delimiter)) {
    addPath(entry)
  }
  for (const name of DIRECTORY_ENVIRONMENT_NAMES) {
    const value = String(environment[name] || "").trim()
    addPath(value)
  }
  for (const name of FILE_ENVIRONMENT_NAMES) {
    const value = String(environment[name] || "").trim()
    addPath(value)
  }
  return [...new Set(values)]
}

export async function resolveExecutableReadPaths(executablePath) {
  const resolved = path.resolve(executablePath)
  const values = [path.dirname(resolved)]
  try {
    const realPath = await fs.realpath(resolved)
    values.push(path.dirname(realPath))
    const packageRoot = nodeModulesPackageRoot(realPath)
    if (packageRoot) values.push(packageRoot)
  } catch {
    // The executable was already resolved and checked by the caller.
  }
  return [...new Set(values)]
}

export function buildCodexSandboxArgs({
  boundary,
  cwd,
  targetBin,
  targetArgs = [],
}) {
  return [
    "sandbox",
    "-C",
    cwd,
    "-P",
    boundary.launcher.name,
    ...boundary.launcher.configArgs,
    "--",
    targetBin,
    ...targetArgs,
  ]
}

function buildRunRules({ stage, runDir, finalPath }) {
  const rules = { ".": "read" }
  const relativeFinalPath = relativeDescendant(runDir, finalPath)
  if (relativeFinalPath) {
    rules[relativeFinalPath] = "write"
  } else if (finalPath) {
    rules[path.resolve(finalPath)] = "write"
  }
  if (stage === "part3") {
    rules.review = "write"
  }
  return rules
}

function addRuntimeIsolationRules(
  filesystem,
  { cwd, projectPath, runtimeRoot, runDir, runRules },
) {
  if (!runtimeRoot) {
    filesystem[runDir] = runRules
    return
  }

  const runtimeContainsWorkspace =
    isSameOrDescendant(cwd, runtimeRoot) ||
    isSameOrDescendant(projectPath, runtimeRoot)
  if (runtimeContainsWorkspace) {
    filesystem[path.join(runtimeRoot, ".env.local")] = "deny"
    filesystem[path.join(runtimeRoot, ".env")] = "deny"
    filesystem[path.join(runtimeRoot, "config.local.json")] = "deny"
    filesystem[path.join(runtimeRoot, ".linear-automation")] = "deny"
  } else {
    filesystem[runtimeRoot] = "deny"
  }
  filesystem[runDir] = runRules
}

function relativeDescendant(parentPath, childPath) {
  if (!childPath) return null
  const relative = path.relative(parentPath, path.resolve(childPath))
  if (!relative || relative === ".") return "."
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return null
  }
  return relative
}

function isSameOrDescendant(candidate, parentPath) {
  const relative = path.relative(parentPath, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
}

function compactProfile(profile) {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined),
  )
}

function addReadPaths(filesystem, filePaths) {
  for (const filePath of filePaths) {
    if (filePath) filesystem[path.resolve(filePath)] = "read"
  }
}

function addWritePaths(filesystem, filePaths) {
  for (const filePath of filePaths) {
    if (filePath) filesystem[path.resolve(filePath)] = "write"
  }
}

function nodeModulesPackageRoot(filePath) {
  const parsed = path.parse(filePath)
  const parts = filePath.slice(parsed.root.length).split(path.sep)
  const nodeModulesIndex = parts.lastIndexOf("node_modules")
  const packageName = parts[nodeModulesIndex + 1]
  if (nodeModulesIndex === -1 || !packageName) return null
  if (parts.length < nodeModulesIndex + 2) return null
  return path.join(
    parsed.root,
    ...parts.slice(0, nodeModulesIndex + 2),
  )
}

function platformRuntimeRules() {
  if (process.platform === "darwin") {
    return {
      "/Applications/Xcode.app/Contents/Developer": "read",
      "/Library/Developer/CommandLineTools": "read",
      "/System/Library/OpenSSL": "read",
    }
  }
  if (process.platform === "linux") {
    return { "/etc/ssl": "read", "/etc/pki": "read" }
  }
  return {}
}

function tomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value).map(
      ([key, entryValue]) => `${JSON.stringify(key)} = ${tomlValue(entryValue)}`,
    )
    return `{ ${entries.join(", ")} }`
  }
  throw new TypeError("Unsupported Codex permission profile value.")
}
