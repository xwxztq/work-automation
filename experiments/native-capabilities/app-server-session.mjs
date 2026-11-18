import fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { StdioRpc } from "./rpc.mjs"
import { RequestBroker } from "./request-broker.mjs"

const output = process.argv[2]
if (!output) throw new Error("Usage: node app-server-session.mjs <output-directory>")
await fs.mkdir(output, { recursive: true })
const env = { ...process.env }
const interactive = process.argv.includes("--interactive")
const broker = new RequestBroker({ emit: value => console.log("SERVER_REQUEST", JSON.stringify(value)) })
for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_PERMISSION_PROFILE"]) delete env[key]
let imageNumber = 0
async function save(value) {
  if (!value || typeof value !== "object") return value
  if (value.type === "image" && value.data) {
    const file = path.join(output, `image-${++imageNumber}.${value.mimeType === "image/jpeg" ? "jpg" : "png"}`)
    await fs.writeFile(file, Buffer.from(value.data, "base64"))
    return { type: "image", file }
  }
  if (Array.isArray(value)) return Promise.all(value.map(save))
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await save(item)])))
}
const rpc = new StdioRpc(process.env.WAUTO_CODEX_BIN || "codex", ["app-server", "--listen", "stdio://"], {
  env, cwd: output,
  onStderr: value => fs.appendFile(path.join(output, "stderr.log"), value).catch(() => {}),
  onNotification: value => {
    save(value).then(async sanitized => {
      await fs.appendFile(path.join(output, "notifications.jsonl"), JSON.stringify(sanitized) + "\n")
      if (["turn/completed", "error", "item/completed"].includes(value.method)) {
        const item = sanitized.params?.item
        console.log("EVENT", JSON.stringify(item?.type === "mcpToolCall"
          ? { method: value.method, type: item.type, server: item.server, tool: item.tool, status: item.status, error: item.error }
          : sanitized).slice(0, 6000))
      }
    }).catch(() => {})
  },
  onRequest: async value => {
    if (interactive) return broker.request(value)
    const p = value.params
    console.log("SERVER_REQUEST", JSON.stringify(value).slice(0, 2500))
    // Approve only the disposable fixture covered by the independent test request.
    if (value.method === "mcpServer/elicitation/request"
      && p?.serverName === "cua_repl"
      && p?._meta?.tool_params?.app === "com.workautomation.NativeCapabilityProbe"
      && p?.message === 'Allow Computer Use to use "NativeCapabilityProbe"?') return { action: "accept", content: {} }
    throw new Error("Approval requires an interactive client; probe does not grant arbitrary access")
  },
})
let id
let requests = Promise.resolve()
let closing = false
async function runRequest(request) {
  if (closing) return
  const params = request.params || {}
  if (params.threadId === "$thread") params.threadId = id
  const result = await save(await rpc.request(request.method, params, request.timeout || 90000))
  await fs.appendFile(path.join(output, "results.jsonl"), JSON.stringify({ method: request.method, result }) + "\n")
  console.log("RESULT", JSON.stringify(result))
}
try {
  await rpc.request("initialize", { clientInfo: { name: "work_automation_capability_probe", version: "0.1.0" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } })
  rpc.notify("initialized")
  const thread = await rpc.request("thread/start", { cwd: output, ephemeral: true, sandbox: "danger-full-access", approvalPolicy: "on-request", experimentalRawEvents: false }, 60000)
  id = thread.thread.id
  console.log("READY", JSON.stringify({ threadId: id, model: thread.model }))
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      const request = JSON.parse(line)
      if (request.method === "close") break
      if (request.method === "respond") {
        broker.respond(request.id, request.result)
        console.log("RESPONDED", request.id)
      } else {
        // Keep ordinary operations ordered, but keep reading stdin while the
        // server waits for a response to an approval or tool request.
        requests = requests.then(() => runRequest(request)).catch(error => console.log("ERROR", error.message))
      }
    } catch (error) { console.log("ERROR", error.message) }
  }
} finally {
  closing = true
  broker.close()
  if (id) await rpc.request("thread/unsubscribe", { threadId: id }).catch(() => {})
  await rpc.close()
  await requests
  process.stdin.pause()
  process.stdin.unref?.()
}
