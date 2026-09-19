#!/usr/bin/env node
import fs from "node:fs/promises"

try {
  const [sessionPath,command] = process.argv.slice(2)
  if (!sessionPath || !command) throw new Error("Usage: browser-client.mjs <session.json> '<action JSON>'")
  const session = JSON.parse(await fs.readFile(sessionPath,"utf8"))
  const endpoint = new URL(session.endpoint)
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/action") throw new Error("Invalid browser session endpoint")
  JSON.parse(command)
  const response = await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.token}`},body:command,signal:AbortSignal.timeout(60000)})
  const result = await response.json()
  console.log(JSON.stringify(result,null,2))
  if (!response.ok) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
