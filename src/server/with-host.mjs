#!/usr/bin/env node
import { spawn } from "node:child_process"
import { RUNTIME_HOST_ENV, normalizeHost, validateHost } from "./host.mjs"

const { command, commandArgs, host } = parseArgs(process.argv.slice(2))

if (!command) {
  console.error("用法: node src/server/with-host.mjs <script> --host <LAN_IP>")
  process.exit(1)
}

const hostError = validateHost(host)
if (hostError) {
  console.error(hostError)
  console.error("示例: pnpm dev:lan --host 192.168.1.23")
  process.exit(1)
}

const child = spawn("pnpm", [command, ...commandArgs], {
  env: {
    ...process.env,
    [RUNTIME_HOST_ENV]: host,
  },
  stdio: "inherit",
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

function parseArgs(argv) {
  let command = ""
  let host = ""
  const commandArgs = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--host") {
      host = normalizeHost(argv[index + 1])
      index += 1
      continue
    }
    if (arg.startsWith("--host=")) {
      host = normalizeHost(arg.slice("--host=".length))
      continue
    }
    if (!command) {
      command = arg
      continue
    }
    commandArgs.push(arg)
  }

  return { command, commandArgs, host }
}

