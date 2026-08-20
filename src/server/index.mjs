#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHttpApi } from "./http-api.mjs"
import { ensureRuntimeLayout, resolveRuntimePaths } from "./app-paths.mjs"
import { applyRuntimeConfigOverrides, loadConfig, validateConfig } from "./config.mjs"
import { loadLocalEnv } from "./env.mjs"
import { createRunStore } from "./run-store.mjs"
import { createScheduler } from "./scheduler.mjs"
import { createSetupManager } from "./setup.mjs"
import {
  applyHostOverride,
  isWildcardHostAllowed,
  RUNTIME_HOST_ENV,
  normalizeHost,
  validateHost,
} from "./host.mjs"
import { createLinearStatusHealthChecker } from "./status-health.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT_DIR = path.resolve(__dirname, "../..")
const args = parseArgs(process.argv.slice(2))
const command = args._[0] || "serve"
const runtimePaths = resolveRuntimePaths({
  appRootDir: APP_ROOT_DIR,
  launchCwd: process.cwd(),
  runtimeRoot: args.runtimeRoot,
  configPath: args.config,
})
await ensureRuntimeLayout(runtimePaths)
await loadLocalEnv(runtimePaths.runtimeRootDir)
const hostOverride = resolveHostOverride(args)

const store = createRunStore(runtimePaths.runtimeRootDir)
const configProvider = async () =>
  applyHostOverride(
    applyRuntimeConfigOverrides(
      await loadConfig(runtimePaths.configPath, runtimePaths.runtimeRootDir),
    ),
    hostOverride,
  )
const linearStatusHealthChecker = createLinearStatusHealthChecker()
const setupManager = createSetupManager({
  configPath: runtimePaths.configPath,
  rootDir: runtimePaths.runtimeRootDir,
})
const scheduler = createScheduler({
  rootDir: runtimePaths.runtimeRootDir,
  configProvider,
  store,
  linearStatusHealthChecker,
})

if (command === "validate-config") {
  const config = await configProvider()
  const result = await validateConfig(config, runtimePaths.runtimeRootDir)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (command === "once") {
  const summary = await scheduler.runOnce(args.stage || "both", {
    issueId: args.issue,
    force: Boolean(args.force),
  })
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

const config = await configProvider()
const hostError = validateHost(config.host, {
  allowWildcard: isWildcardHostAllowed(),
})
if (hostError) {
  console.error(hostError)
  process.exit(1)
}

const server = createHttpApi({
  configPath: runtimePaths.configPath,
  rootDir: runtimePaths.runtimeRootDir,
  staticRootDir: runtimePaths.appRootDir,
  scheduler,
  store,
  setupManager,
  linearStatusHealthChecker,
  dev: Boolean(args.dev),
})

server.listen(config.port, config.host, () => {
  console.log(`Linear 自动执行服务已监听 http://${config.host}:${config.port}`)
  console.log(`用户数据目录: ${runtimePaths.runtimeRootDir}`)
})

const setupStatus = await setupManager.status()
if (!args.dev && setupStatus.ready) {
  scheduler.start()
} else if (!setupStatus.ready) {
  console.log("首次配置尚未完成，后台扫描暂不启动。")
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

function shutdown() {
  scheduler.stop()
  server.close(() => process.exit(0))
}

function resolveHostOverride(parsedArgs) {
  if (parsedArgs.host === true) {
    console.error("--host 需要指定一个具体 IP，例如 --host 192.168.1.23。")
    process.exit(1)
  }
  return normalizeHost(parsedArgs.host) || normalizeHost(process.env[RUNTIME_HOST_ENV])
}

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith("--")) {
      const option = arg.slice(2)
      const equalsIndex = option.indexOf("=")
      if (equalsIndex !== -1) {
        const key = option.slice(0, equalsIndex).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
        parsed[key] = option.slice(equalsIndex + 1)
        continue
      }
      const key = option.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      const next = argv[index + 1]
      if (!next || next.startsWith("--")) {
        parsed[key] = true
      } else {
        parsed[key] = next
        index += 1
      }
    } else {
      parsed._.push(arg)
    }
  }
  return parsed
}
