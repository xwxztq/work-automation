import path from "node:path"

import { loadConfig, saveConfig } from "./config.mjs"
import { writeLocalEnvValue } from "./env.mjs"
import { resolveCodexExecutable } from "./executable.mjs"
import { createLinearClient } from "./linear-client.mjs"

export function createSetupManager({
  configPath,
  rootDir,
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
    const apiKeyEnv = String(config.linear?.apiKeyEnv || "LINEAR_API_KEY").trim()
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
      ready: apiKeySet && codexFound && absolutePathSaved,
      needsSetup: !apiKeySet || !codexFound || !absolutePathSaved,
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
    const apiKeyEnv = String(config.linear?.apiKeyEnv || "LINEAR_API_KEY").trim()
    const suppliedApiKey = String(input.linearApiKey || "").trim()
    const apiKey = suppliedApiKey || String(env[apiKeyEnv] || "").trim()
    if (!apiKey) {
      throw new Error(`请填写 Linear API key（保存为 ${apiKeyEnv}）。`)
    }

    try {
      await createLinear(apiKey).listProjects()
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
