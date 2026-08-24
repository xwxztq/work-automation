import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { resolveExecutable } from "./executable.mjs"

const LAUNCHER_PROFILE_NAME = "work-automation-launcher"
const MAX_MAC_RUNTIME_DEPENDENCIES = 256
const MAC_RUNTIME_CACHE_TTL_MS = 60_000
const macRuntimeReadPathCache = new Map()
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

export async function resolveExecutableReadPaths(executablePath, options = {}) {
  const resolved = path.resolve(executablePath)
  const values = [path.dirname(resolved)]
  let realPath = resolved
  try {
    realPath = await fs.realpath(resolved)
    values.push(path.dirname(realPath))
    const packageRoot = nodeModulesPackageRoot(realPath)
    if (packageRoot) values.push(packageRoot)
  } catch {
    // The executable was already resolved and checked by the caller.
  }
  const seenExecutables = options.seenExecutables || new Set()
  if (!seenExecutables.has(realPath)) {
    seenExecutables.add(realPath)
    const interpreterPath = await resolveScriptInterpreter(realPath, options)
    if (interpreterPath) {
      values.push(
        ...(await resolveExecutableReadPaths(interpreterPath, {
          ...options,
          seenExecutables,
        })),
      )
    }
  }
  const platform = options.platform || process.platform
  if (platform === "darwin") {
    const inspectMacBinaries = options.inspectMacBinary
      ? batchSingleMacInspector(options.inspectMacBinary)
      : inspectMacExecutables
    try {
      if (options.inspectMacBinary || (await isMachOBinary(realPath))) {
        const runtimeReadPaths = options.inspectMacBinary
          ? await inspectMacRuntimeReadPaths(realPath, inspectMacBinaries)
          : await cachedMacRuntimeReadPaths(realPath, inspectMacBinaries)
        values.push(...runtimeReadPaths)
      }
    } catch {
      // Some executables are scripts or non-Mach-O binaries. Their already
      // resolved executable and package paths remain available.
    }
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

async function isMachOBinary(filePath) {
  const handle = await fs.open(filePath, "r")
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length) return false
    return new Set([
      "bebafeca",
      "bfbafeca",
      "cafebabe",
      "cafebabf",
      "cefaedfe",
      "cffaedfe",
      "feedface",
      "feedfacf",
    ]).has(header.toString("hex"))
  } finally {
    await handle.close()
  }
}

async function resolveScriptInterpreter(filePath, options) {
  const handle = await fs.open(filePath, "r")
  let header = ""
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    header = buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
  const firstLine = header.split(/\r?\n/u, 1)[0]
  const shebangMatch = firstLine.match(/^#!\s*(\S+)(?:\s+(.+))?$/u)
  if (!shebangMatch) return null
  const launcher = shebangMatch[1]
  const launcherArgs = String(shebangMatch[2] || "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
  if (path.basename(launcher) !== "env") {
    return resolveExecutable(launcher, {
      cwd: options.cwd,
      path: options.path,
    })
  }
  const command = launcherArgs.find(
    (value) => value !== "--" && value !== "-S" && !value.startsWith("-") && !value.includes("="),
  )
  if (!command) return null
  return resolveExecutable(command, {
    cwd: options.cwd,
    path: options.path,
  })
}

async function inspectMacRuntimeReadPaths(executablePath, inspectMacBinaries) {
  const inspections = await inspectMacBinaries([executablePath])
  const inspection = inspections.get(executablePath) || {
    dependencies: [],
    rpaths: [],
  }
  return resolveMacRuntimeReadPaths(
    executablePath,
    inspection,
    inspectMacBinaries,
  )
}

async function cachedMacRuntimeReadPaths(executablePath, inspectMacBinaries) {
  const stat = await fs.stat(executablePath)
  const cacheKey = `${executablePath}:${stat.size}:${stat.mtimeMs}`
  const cached = macRuntimeReadPathCache.get(cacheKey)
  if (cached?.expiresAt > Date.now()) return cached.pending
  const entry = {
    expiresAt: Date.now() + MAC_RUNTIME_CACHE_TTL_MS,
    pending: inspectMacRuntimeReadPaths(executablePath, inspectMacBinaries),
  }
  macRuntimeReadPathCache.set(cacheKey, entry)
  if (!cached) {
    if (macRuntimeReadPathCache.size > 32) {
      const oldestKey = macRuntimeReadPathCache.keys().next().value
      if (oldestKey !== cacheKey) macRuntimeReadPathCache.delete(oldestKey)
    }
  }
  try {
    return await entry.pending
  } catch (error) {
    if (macRuntimeReadPathCache.get(cacheKey) === entry) {
      macRuntimeReadPathCache.delete(cacheKey)
    }
    throw error
  }
}

function batchSingleMacInspector(inspectMacBinary) {
  return async (filePaths) => {
    const entries = await Promise.all(
      filePaths.map(async (filePath) => [filePath, await inspectMacBinary(filePath)]),
    )
    return new Map(entries)
  }
}

async function inspectMacExecutables(filePaths) {
  const results = new Map()
  for (const chunk of chunkValues([...new Set(filePaths)], 64)) {
    const dependencyOutput = await readProcessOutput("/usr/bin/otool", [
      "-L",
      ...chunk,
    ])
    const dependencySections = splitOtoolSections(dependencyOutput, chunk)
    const rpathTargets = chunk.filter((filePath) =>
      parseOtoolDependencies(dependencySections.get(filePath)).some((dependency) =>
        dependency.startsWith("@rpath/"),
      ),
    )
    let rpathSections = new Map()
    if (rpathTargets.length > 0) {
      const rpathOutput = await readProcessOutput("/usr/bin/otool", [
        "-l",
        ...rpathTargets,
      ])
      rpathSections = splitOtoolSections(rpathOutput, rpathTargets)
    }
    for (const filePath of chunk) {
      results.set(filePath, {
        dependencies: parseOtoolDependencies(
          dependencySections.get(filePath),
        ),
        rpaths: parseMachOLoadCommands(
          rpathSections.get(filePath)?.join("\n") || "",
        ).rpaths,
      })
    }
  }
  return results
}

function splitOtoolSections(output, filePaths) {
  const headers = new Map(filePaths.map((filePath) => [`${filePath}:`, filePath]))
  const sections = new Map(filePaths.map((filePath) => [filePath, []]))
  let current = filePaths.length === 1 ? filePaths[0] : null
  for (const line of String(output || "").split(/\r?\n/u)) {
    const headerPath = headers.get(line)
    if (headerPath) {
      current = headerPath
      continue
    }
    if (current) sections.get(current).push(line)
  }
  return sections
}

function parseOtoolDependencies(lines = []) {
  const values = []
  for (const line of lines) {
    const match = line.match(
      /^\s+(.+?)\s+\(compatibility version\s+[^)]+\)$/u,
    )
    if (match) values.push(match[1])
  }
  return values
}

function parseMachOLoadCommands(output) {
  const dependencies = []
  const rpaths = []
  const dependencyCommands = new Set([
    "LC_LAZY_LOAD_DYLIB",
    "LC_LOAD_DYLIB",
    "LC_LOAD_UPWARD_DYLIB",
    "LC_LOAD_WEAK_DYLIB",
    "LC_REEXPORT_DYLIB",
  ])
  let command = null
  for (const line of String(output || "").split(/\r?\n/u)) {
    const commandMatch = line.match(/^\s*cmd\s+(LC_[A-Z0-9_]+)/u)
    if (commandMatch) {
      command = commandMatch[1]
      continue
    }
    if (dependencyCommands.has(command)) {
      const dependencyMatch = line.match(/^\s*name\s+(.+?)\s+\(offset\s+\d+\)/u)
      if (dependencyMatch) {
        dependencies.push(dependencyMatch[1])
        command = null
      }
      continue
    }
    if (command === "LC_RPATH") {
      const rpathMatch = line.match(/^\s*path\s+(.+?)\s+\(offset\s+\d+\)/u)
      if (rpathMatch) {
        rpaths.push(rpathMatch[1])
        command = null
      }
    }
  }
  return { dependencies, rpaths }
}

async function resolveMacRuntimeReadPaths(
  executablePath,
  inspection = {},
  inspectMacBinaries,
) {
  const executableDir = path.dirname(executablePath)
  const executableRpaths = (inspection.rpaths || [])
    .map((value) => expandMachPath(value, { executableDir, loaderDir: executableDir }))
    .filter(Boolean)
  const values = []
  const visited = new Set([executablePath])
  let pending = [{ filePath: executablePath, inspection }]

  while (pending.length > 0 && visited.size <= MAX_MAC_RUNTIME_DEPENDENCIES) {
    const discovered = new Set()
    for (const entry of pending) {
      const loaderDir = path.dirname(entry.filePath)
      const localRpaths = (entry.inspection?.rpaths || [])
        .map((value) => expandMachPath(value, { executableDir, loaderDir }))
        .filter(Boolean)
      const rpaths = [...new Set([...localRpaths, ...executableRpaths])]
      const candidates = resolveMacDependencyCandidates(
        entry.inspection?.dependencies,
        { executableDir, loaderDir, rpaths },
      )
      for (const candidate of candidates) {
        if (isMacSystemRuntimePath(candidate)) continue
        try {
          const realPath = await fs.realpath(candidate)
          await addRuntimeLibraryReadPaths(values, candidate)
          await addRuntimeLibraryReadPaths(values, realPath)
          values.push(...(await homebrewRuntimeSupportReadPaths(candidate)))
          if (
            inspectMacBinaries &&
            visited.size + discovered.size < MAX_MAC_RUNTIME_DEPENDENCIES &&
            !visited.has(realPath)
          ) {
            discovered.add(realPath)
          }
        } catch {
          // dyld can report fallback candidates that do not exist. Do not
          // widen the profile for a path that is not installed.
        }
      }
    }
    const targets = [...discovered]
    for (const target of targets) visited.add(target)
    if (targets.length === 0) {
      pending = []
      continue
    }
    try {
      const inspections = await inspectMacBinaries(targets)
      pending = targets.map((filePath) => ({
        filePath,
        inspection: inspections.get(filePath) || {
          dependencies: [],
          rpaths: [],
        },
      }))
    } catch {
      pending = []
    }
  }
  return [...new Set(values)]
}

function resolveMacDependencyCandidates(
  dependencies = [],
  { executableDir, loaderDir, rpaths },
) {
  const candidates = []
  for (const dependency of dependencies) {
    if (dependency.startsWith("@rpath/")) {
      const suffix = dependency.slice("@rpath/".length)
      for (const rpath of rpaths) {
        candidates.push(path.resolve(rpath, suffix))
      }
      continue
    }
    const expanded = expandMachPath(dependency, {
      executableDir,
      loaderDir,
    })
    if (expanded) candidates.push(expanded)
  }
  return candidates
}

function expandMachPath(value, { executableDir, loaderDir }) {
  const input = String(value || "").trim()
  if (!input) return null
  if (path.isAbsolute(input)) return path.resolve(input)
  if (input === "@loader_path") return loaderDir
  if (input.startsWith("@loader_path/")) {
    return path.resolve(loaderDir, input.slice("@loader_path/".length))
  }
  if (input === "@executable_path") return executableDir
  if (input.startsWith("@executable_path/")) {
    return path.resolve(executableDir, input.slice("@executable_path/".length))
  }
  return null
}

async function addRuntimeLibraryReadPaths(values, filePath) {
  const resolved = path.resolve(filePath)
  values.push(resolved)
  values.push(...(await symlinkAncestors(resolved)))
  const parent = path.dirname(resolved)
  if (
    /^(?:lib|lib64)$/iu.test(path.basename(parent)) ||
    parent.includes(`${path.sep}.framework${path.sep}`) ||
    parent.includes(".framework")
  ) {
    values.push(parent)
  }
}

async function symlinkAncestors(filePath) {
  const parsed = path.parse(filePath)
  const parts = filePath.slice(parsed.root.length).split(path.sep).filter(Boolean)
  const values = []
  let current = parsed.root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const entry = await fs.lstat(current)
      if (entry.isSymbolicLink()) {
        values.push(current)
        const parent = path.dirname(current)
        if (path.basename(parent) === "opt") {
          const target = await fs.realpath(current)
          if (target.split(path.sep).includes("Cellar")) values.push(parent)
        }
      }
    } catch {
      break
    }
  }
  return values
}

async function homebrewRuntimeSupportReadPaths(filePath) {
  const parsed = path.parse(filePath)
  const parts = filePath.slice(parsed.root.length).split(path.sep).filter(Boolean)
  const optIndex = parts.lastIndexOf("opt")
  const formula = parts[optIndex + 1]
  if (
    optIndex === -1 ||
    !formula ||
    !/^openssl(?:@[^/]+)?$/iu.test(formula)
  ) {
    return []
  }
  const homebrewPrefix = path.join(parsed.root, ...parts.slice(0, optIndex))
  const configPath = path.join(
    homebrewPrefix,
    "etc",
    formula,
    "openssl.cnf",
  )
  try {
    return [configPath, await fs.realpath(configPath)]
  } catch {
    return []
  }
}

function chunkValues(values, size) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function isMacSystemRuntimePath(filePath) {
  return (
    filePath === "/usr/lib" ||
    filePath.startsWith("/usr/lib/") ||
    filePath === "/System/Library" ||
    filePath.startsWith("/System/Library/")
  )
}

function readProcessOutput(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["ignore", "pipe", "ignore"],
    })
    let output = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      if (output.length < 4 * 1024 * 1024) output += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`otool exited with code ${code}`))
    })
  })
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
