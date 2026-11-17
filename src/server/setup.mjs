import path from "node:path"

import { loadConfig, saveConfig } from "./config.mjs"
import { writeLocalEnvValue } from "./env.mjs"
import { resolveCodexExecutable } from "./executable.mjs"
import { createLinearClient } from "./linear-client.mjs"
import { auditIssueAdapter } from "./issue-audit.mjs"
import { activeWorkspaceId, linearWorkspaces } from "./linear-workspaces.mjs"

export function createSetupManager({
  configPath,
  rootDir,
  store,
  env = process.env,
  load = loadConfig,
  save = saveConfig,
  writeEnv = writeLocalEnvValue,
  resolveCodex = resolveCodexExecutable,
  createLinear = createLinearClient,
} = {}) {
  if (!configPath || !rootDir) {
    throw new Error("首次配置管理器缺少 configPath 或 rootDir。")
  }

  async function status() {
    const config = await load(configPath, rootDir)
    const workspace = linearWorkspaces(config).find((item) => item.id === activeWorkspaceId(config))
    const apiKeyEnv = workspace.apiKeyEnv
    const configuredBin = String(config.codex?.bin || "codex").trim() || "codex"
    const resolvedBin = await resolveCodex(configuredBin, {
      cwd: rootDir,
      path: env.PATH,
      env,
    })
    const apiKeySet = Boolean(String(env[apiKeyEnv] || "").trim())
    const codexFound = Boolean(resolvedBin)
    const absolutePathSaved = path.isAbsolute(configuredBin) && configuredBin === resolvedBin

    return {
      ready: apiKeySet && codexFound,
      needsSetup: !apiKeySet || !codexFound,
      runtimeRootDir: rootDir,
      configPath,
      linear: {
        apiKeyEnv,
        apiKeySet,
      },
      codex: {
        configuredBin,
        resolvedBin,
        found: codexFound,
        absolutePathSaved,
      },
      projectsConfigured: config.projects.length,
    }
  }

  async function configure(input = {}) {
    const config = await load(configPath, rootDir)
    const workspace = linearWorkspaces(config).find((item) => item.id === activeWorkspaceId(config))
    const apiKeyEnv = workspace.apiKeyEnv
    const suppliedApiKey = String(input.linearApiKey || "").trim()
    const apiKey = suppliedApiKey || String(env[apiKeyEnv] || "").trim()
    if (!apiKey) {
      throw new Error(`请填写 Linear API key（保存为 ${apiKeyEnv}）。`)
    }

    try {
      const linear = auditIssueAdapter(createLinear(apiKey), store, { stage: "setup" })
      const organizationId = workspace.organizationId || (workspace.id !== "default" ? workspace.id : null)
      if (organizationId && (await linear.readOrganization()).id !== organizationId) {
        throw new Error("密钥所属的 Linear 工作区与当前绑定不一致。")
      }
      await linear.listProjects()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Linear API key 校验失败: ${message}`)
    }

    const suppliedCodexBin = String(input.codexBin || "").trim()
    const configuredCodexBin = suppliedCodexBin || config.codex?.bin || "codex"
    const resolvedCodexBin = await resolveCodex(configuredCodexBin, {
      cwd: rootDir,
      path: env.PATH,
      env,
      fallbackKnownLocations: !isPathLike(suppliedCodexBin),
    })
    if (!resolvedCodexBin) {
      throw new Error(`找不到可执行的 Codex: ${configuredCodexBin}`)
    }

    await save(
      configPath,
      {
        ...config,
        codex: {
          ...config.codex,
          bin: resolvedCodexBin,
        },
      },
      rootDir,
    )

    if (suppliedApiKey) {
      await writeEnv(rootDir, apiKeyEnv, suppliedApiKey)
      env[apiKeyEnv] = suppliedApiKey
    }

    return status()
  }

  return { status, configure }
}

function isPathLike(value) {
  return Boolean(value && (value.includes("/") || value.includes("\\")))
}
