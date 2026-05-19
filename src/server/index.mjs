#!/usr/bin/env node
import { createHttpApi } from "./http-api.mjs"
import { loadConfig, validateConfig } from "./config.mjs"
import { createRunStore } from "./run-store.mjs"
import { createScheduler } from "./scheduler.mjs"

const ROOT_DIR = process.cwd()
const args = parseArgs(process.argv.slice(2))
const command = args._[0] || "serve"
const configPath = args.config || "config.local.json"

const store = createRunStore(ROOT_DIR)
const configProvider = () => loadConfig(configPath, ROOT_DIR)
const scheduler = createScheduler({ rootDir: ROOT_DIR, configProvider, store })

if (command === "validate-config") {
  const config = await configProvider()
  const result = await validateConfig(config, ROOT_DIR)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (command === "once") {
  const summary = await scheduler.runOnce(args.stage || "both", { issueId: args.issue })
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

const config = await configProvider()
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

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
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
