#!/usr/bin/env node
import { createHttpApi } from "./http-api.mjs"
import { applyRuntimeConfigOverrides, loadConfig, validateConfig } from "./config.mjs"
import { loadLocalEnv } from "./env.mjs"
import { createRunStore } from "./run-store.mjs"
import { createScheduler } from "./scheduler.mjs"
import {
  applyHostOverride,
  isWildcardHostAllowed,
  RUNTIME_HOST_ENV,
  normalizeHost,
  validateHost,
} from "./host.mjs"

const ROOT_DIR = process.cwd()
const args = parseArgs(process.argv.slice(2))
const command = args._[0] || "serve"
const configPath = args.config || "config.local.json"
await loadLocalEnv(ROOT_DIR)
const hostOverride = resolveHostOverride(args)

const store = createRunStore(ROOT_DIR)
const configProvider = async () =>
  applyHostOverride(
    applyRuntimeConfigOverrides(await loadConfig(configPath, ROOT_DIR)),
    hostOverride,
  )
const scheduler = createScheduler({ rootDir: ROOT_DIR, configProvider, store })

if (command === "validate-config") {
  const config = await configProvider()
  const result = await validateConfig(config, ROOT_DIR)
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
  configPath,
  scheduler,
  store,
  dev: Boolean(args.dev),
})

server.listen(config.port, config.host, () => {
  console.log(`Linear 自动执行服务已监听 http://${config.host}:${config.port}`)
})

if (!args.dev) {
  scheduler.start()
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
