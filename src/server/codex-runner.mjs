import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildAgentResultOutputSchema } from "./agent-result-runtime.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"
import {
  assertCodexSandboxPaths,
  buildCodexPermissionBoundary,
  buildCodexRuntimeReadPaths,
  buildCodexSandboxArgs,
  resolveExecutableReadPaths,
} from "./codex-permissions.mjs"
import { resolveExecutable } from "./executable.mjs"

const FORCE_KILL_DELAY_MS = 5000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUPERVISOR_PATH = path.join(__dirname, "codex-supervisor.mjs")
const SANDBOX_TARGET_PATH = path.join(__dirname, "codex-sandbox-target.mjs")

export async function runCodex({
  config,
  project,
  stage,
  run,
  prompt,
  store,
  signal,
  onChild,
  environment = process.env,
  supervisorPath = SUPERVISOR_PATH,
  sandboxExecutable,
  runtimeRoot,
}) {
  await assertCodexSandboxPaths([
    project.codexCwd || project.path,
    project.path,
    runtimeRoot || path.dirname(run.dir),
    run.dir,
  ])
  await fs.writeFile(run.promptPath, prompt)

  const configuredCodexBin = config.codex.bin || "codex"
  const resolvedCodexBin = await resolveExecutable(configuredCodexBin, {
    cwd: project.codexCwd || project.path,
  })
  if (!resolvedCodexBin) {
    throw new Error(
      `未找到 Codex 可执行文件: ${configuredCodexBin}。请在启动服务的进程 PATH 中加入 codex，或把 config.local.json 的 codex.bin 改成绝对路径。`,
    )
  }
  const resolvedSandboxBin = sandboxExecutable
    ? await resolveExecutable(sandboxExecutable, {
        cwd: project.codexCwd || project.path,
      })
    : resolvedCodexBin
  if (!resolvedSandboxBin) {
    throw new Error(
      `未找到支持 permission profile 的 Codex sandbox 启动器: ${sandboxExecutable}。`,
    )
  }
  const resultSchemaPath =
    run.resultSchemaPath || path.join(run.dir, "agent-result-schema.json")
  const resultSchema = buildAgentResultOutputSchema(run.agentResultContext)
  await fs.writeFile(resultSchemaPath, `${JSON.stringify(resultSchema, null, 2)}\n`)
  const linearApiKeyEnv = String(
    config.linear?.apiKeyEnv || "LINEAR_API_KEY",
  ).trim()
  const blockedEnvironmentNames = [linearApiKeyEnv].filter(Boolean)
  const gitIdentityEnvironment = await resolveGitIdentityEnvironment({
    cwd: project.codexCwd || project.path,
    environment,
  })
  const codexEnvironment = buildCodexProcessEnv(
    {
      ...environment,
      ...gitIdentityEnvironment,
      GIT_CONFIG_GLOBAL: os.devNull,
    },
    { blockedNames: blockedEnvironmentNames },
  )
  const sourceCodexHome = resolveCodexHome(codexEnvironment)
  codexEnvironment.CODEX_HOME = sourceCodexHome
  codexEnvironment.PATH = excludePathTree(
    codexEnvironment.PATH,
    sourceCodexHome,
  )
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || path.dirname(run.dir))
  const supervisorInputPath = path.join(run.dir, "supervisor-input.json")
  const sandboxUserHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-automation-codex-"),
  )
  const sandboxTempDir = path.join(sandboxUserHome, "tmp")
  const launcherCodexHome = path.join(sandboxUserHome, ".codex-launcher")
  const innerCodexHome = path.join(sandboxUserHome, ".codex-runtime")
  const credentialFilePaths = [
    path.join(resolvedRuntimeRoot, ".env.local"),
    path.join(resolvedRuntimeRoot, ".env"),
  ]
  const runtimeReadPaths = buildCodexRuntimeReadPaths(codexEnvironment)
  const [codexExecutableReadPaths, nodeExecutableReadPaths] = await Promise.all([
    resolveExecutableReadPaths(resolvedCodexBin, {
      cwd: project.codexCwd || project.path,
      path: codexEnvironment.PATH,
    }),
    resolveExecutableReadPaths(process.execPath, {
      cwd: project.codexCwd || project.path,
      path: codexEnvironment.PATH,
    }),
  ])
  const launcherReadPaths = [
    SANDBOX_TARGET_PATH,
    ...codexExecutableReadPaths,
    ...nodeExecutableReadPaths,
  ]
  const permissionBoundary = buildCodexPermissionBoundary({
    stage,
    cwd: project.codexCwd || project.path,
    projectPath: project.path,
    runtimeRoot: resolvedRuntimeRoot,
    runDir: run.dir,
    finalPath: run.finalPath,
    credentialFilePaths,
    runtimeReadPaths,
    launcherReadPaths,
    runtimeWritePaths: [sandboxUserHome],
  })
  const args = buildCodexArgs({
    config,
    project,
    run: { ...run, resultSchemaPath },
  })
  if (stage === "part3") {
    await fs.mkdir(path.join(run.dir, "review"), { recursive: true })
  }
  await fs.mkdir(sandboxTempDir, { recursive: true })
  const launchArgs = buildCodexSandboxArgs({
    boundary: permissionBoundary,
    cwd: project.codexCwd || project.path,
    targetBin: process.execPath,
    targetArgs: [SANDBOX_TARGET_PATH, supervisorInputPath],
  })
  await fs.writeFile(
    supervisorInputPath,
    `${JSON.stringify(
      {
        codexBin: resolvedCodexBin,
        args,
        launchBin: resolvedSandboxBin,
        launchArgs,
        cwd: project.codexCwd || project.path,
        promptPath: run.promptPath,
        stdoutPath: run.stdoutPath,
        stderrPath: run.stderrPath,
        finalPath: run.finalPath,
        metadataPath: run.metadataPath,
        resultSchemaPath,
        agentResultContext: run.agentResultContext,
        blockedEnvironmentNames,
        launcherCodexHome,
        innerCodexHome,
        sandboxUserHome,
        sandboxTempDir,
      },
      null,
      2,
    )}\n`,
  )

  const supervisor = spawn(process.execPath, [supervisorPath, supervisorInputPath], {
    cwd: project.codexCwd || project.path,
    env: codexEnvironment,
    detached: true,
    stdio: "ignore",
  })
  const started = Number.isInteger(supervisor.pid) && supervisor.pid > 0
  const supervisorPid = started ? supervisor.pid : null
  let canceled = false
  let forceKillTimer = null
  let supervisorError = null

  const appendRunError = (message) => {
    void store.appendText(run.stderrPath, message).catch(() => {})
  }

  const cancelSupervisor = (reason = "用户中止任务") => {
    canceled = true
    appendRunError(`${reason}\n`)
    if (!started || supervisor.exitCode != null || supervisor.killed) {
      return
    }
    supervisor.kill("SIGTERM")
    forceKillTimer = setTimeout(() => {
      if (supervisor.exitCode == null) {
        appendRunError("Codex supervisor 未及时退出，已强制停止。\n")
        supervisor.kill("SIGKILL")
      }
    }, FORCE_KILL_DELAY_MS)
  }

  if (signal?.aborted) {
    cancelSupervisor(abortReason(signal, "用户中止任务"))
  } else {
    signal?.addEventListener(
      "abort",
      () => cancelSupervisor(abortReason(signal, "用户中止任务")),
      { once: true },
    )
  }

  onChild?.({
    pid: supervisorPid,
    supervisorPid,
  })

  const supervisorExitCode = await new Promise((resolve) => {
    supervisor.on("error", async (error) => {
      supervisorError = error
      await store.appendText(run.stderrPath, `${error.stack || error.message}\n`)
      resolve(1)
    })
    supervisor.on("close", (code) => resolve(code ?? 0))
  })

  if (forceKillTimer) {
    clearTimeout(forceKillTimer)
  }

  const latestRun = await readJsonFile(run.metadataPath, run)
  const finalText = await readOptional(run.finalPath)
  const codexStarted = Boolean(latestRun.codexStarted)
  await fs.rm(sandboxUserHome, { recursive: true, force: true }).catch(() => {})

  return {
    exitCode: latestRun.exitCode ?? supervisorExitCode,
    status: latestRun.status,
    finalText,
    canceled: canceled || latestRun.status === "canceled",
    started: codexStarted,
    startError: !started
      ? supervisorError?.message || "Codex supervisor 没有成功启动。"
      : latestRun.startupError || null,
    supervisorPid: latestRun.supervisorPid || supervisorPid,
    codexPid: latestRun.codexPid || null,
    error: latestRun.error || null,
    agentResult: latestRun.agentResult,
    agentResultValidation: latestRun.agentResultValidation,
    failureKind: latestRun.failureKind,
    failureSummary: latestRun.failureSummary,
    failureAction: latestRun.failureAction,
    retryableFailure: latestRun.retryableFailure,
  }
}

function normalizeCodexDefaultArgs(defaultArgs = []) {
  const input = Array.isArray(defaultArgs)
    ? defaultArgs.map((value) => String(value).trim()).filter(Boolean)
    : []
  const normalized = []
  const runnerOwnedValueFlags = new Set([
    "--sandbox",
    "-s",
    "--cd",
    "-C",
    "--output-last-message",
    "-o",
    "--output-schema",
    "--profile",
    "-p",
    "--ask-for-approval",
    "-a",
    "--add-dir",
  ])

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index]
    if (runnerOwnedValueFlags.has(value)) {
      index += 1
      continue
    }
    if (
      [
        "--approve-for-me",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "--ephemeral",
        "--ignore-rules",
        "--ignore-user-config",
        "-",
      ].includes(value)
    ) {
      continue
    }
    if (isRunnerOwnedInlineArg(value)) {
      continue
    }
    if (value === "--config" || value === "-c") {
      const override = input[index + 1]
      index += 1
      if (!override || isBlockedCodexConfigOverride(override)) {
        continue
      }
      normalized.push(value, override)
      continue
    }
    if (value === "--enable" || value === "--disable") {
      const feature = input[index + 1]
      index += 1
      if (!feature || /(?:hook|mcp|network_proxy|plugin)/iu.test(feature)) {
        continue
      }
      normalized.push(value, feature)
      continue
    }
    if (
      value.startsWith("--config=") ||
      value.startsWith("-c=")
    ) {
      if (!isBlockedCodexConfigOverride(value.slice(value.indexOf("=") + 1))) {
        normalized.push(value)
      }
      continue
    }
    if (isBlockedCodexConfigOverride(value)) {
      continue
    }
    normalized.push(value)
  }
  if (normalized.includes("--skip-git-repo-check")) {
    return normalized
  }
  return [...normalized, "--skip-git-repo-check"]
}

export function buildCodexArgs({ config, project, run }) {
  // The supervisor launches this command inside the external permission profile.
  // macOS rejects a second nested Seatbelt policy, so exec must use that boundary.
  return [
    "exec",
    ...normalizeCodexDefaultArgs(config.codex.defaultArgs),
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "mcp_servers={}",
    "-C",
    project.codexCwd || project.path,
    "--output-last-message",
    run.finalPath,
    "--output-schema",
    run.resultSchemaPath,
    "-",
  ]
}

function resolveCodexHome(environment) {
  const configured = String(environment.CODEX_HOME || "").trim()
  if (configured) return path.resolve(configured)
  const home = String(
    environment.HOME || environment.USERPROFILE || os.homedir(),
  ).trim()
  return path.join(home, ".codex")
}

function excludePathTree(searchPath, blockedRoot) {
  const resolvedRoot = path.resolve(blockedRoot)
  return String(searchPath || "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => {
      if (!path.isAbsolute(entry)) return false
      const relative = path.relative(resolvedRoot, path.resolve(entry))
      return (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
    })
    .join(path.delimiter)
}

async function resolveGitIdentityEnvironment({ cwd, environment }) {
  const gitBin = await resolveExecutable("git", {
    cwd,
    path: environment.PATH,
  })
  if (!gitBin) return {}
  const [name, email] = await Promise.all([
    readProcessText(gitBin, ["config", "--get", "user.name"], cwd, environment),
    readProcessText(gitBin, ["config", "--get", "user.email"], cwd, environment),
  ])
  return {
    ...(name
      ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name }
      : {}),
    ...(email
      ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email }
      : {}),
  }
}

function readProcessText(bin, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    })
    let output = ""
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      if (output.length < 4096) output += chunk
    })
    child.once("error", () => finish(""))
    child.once("close", (code) => finish(code === 0 ? output.trim() : ""))
  })
}

function isBlockedCodexConfigOverride(value) {
  return /(?:approval_policy|bearer_token|default_permissions|features\.network_proxy|hooks?|linear[^=]*(?:token|key|auth)|mcp_servers|permissions|plugins?|sandbox)/iu.test(
    String(value || ""),
  )
}

function isRunnerOwnedInlineArg(value) {
  if (
    [
      "--sandbox=",
      "--cd=",
      "--output-last-message=",
      "--output-schema=",
      "--profile=",
      "--add-dir=",
      "--ask-for-approval=",
      "--ignore-user-config=",
    ].some((prefix) => value.startsWith(prefix))
  ) {
    return true
  }
  return (
    !value.startsWith("--") &&
    ["-C", "-o", "-p", "-s"].some(
      (prefix) => value.startsWith(prefix) && value.length > prefix.length,
    )
  )
}

function abortReason(signal, fallback) {
  if (!signal?.reason) {
    return fallback
  }
  return typeof signal.reason === "string" ? signal.reason : fallback
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback
    }
    throw error
  }
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      return ""
    }
    throw error
  }
}
