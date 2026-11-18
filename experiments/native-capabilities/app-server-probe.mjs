import fs from "node:fs/promises"
import path from "node:path"
import { StdioRpc } from "./rpc.mjs"

const output = process.argv[2]
if (!output) throw new Error("Usage: node app-server-probe.mjs <output-directory>")
await fs.mkdir(output, { recursive: true })
const logs = []
const env = { ...process.env }
// A standalone host must not masquerade as the active desktop task.
delete env.CODEX_THREAD_ID
delete env.CODEX_SESSION_ID
delete env.CODEX_APP_TOOLS_PIPE_PATH
delete env.CODEX_PERMISSION_PROFILE
const rpc = new StdioRpc(process.env.WAUTO_CODEX_BIN || "codex", ["app-server", "--listen", "stdio://"], {
  env,
  cwd: output,
  onStderr: value => logs.push(value),
  onNotification: value => { if (/error|failed/i.test(value.method)) console.log("NOTIFICATION", value.method, JSON.stringify(value.params).slice(0, 1500)) },
  onRequest: async value => { console.log("SERVER_REQUEST", value.method, JSON.stringify(value.params).slice(0, 1200)); throw new Error("Independent inventory probe does not grant approvals") },
})
try {
  const init = await rpc.request("initialize", { clientInfo: { name: "work_automation_capability_probe", version: "0.1.0" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } })
  rpc.notify("initialized")
  console.log("INITIALIZE", JSON.stringify(init))
  for (const [method, params] of [["plugin/installed", {}], ["app/installed", {}], ["skills/list", { cwds: [output] }]]) {
    try {
      const result = await rpc.request(method, params, 45000)
      await fs.writeFile(path.join(output, method.replaceAll("/", "-") + ".json"), JSON.stringify(result, null, 2))
      console.log("INVENTORY", method, "saved", Object.keys(result))
    } catch (error) { console.log("INVENTORY_ERROR", method, error.message) }
  }
  const thread = await rpc.request("thread/start", { cwd: output, ephemeral: true, sandbox: "danger-full-access", approvalPolicy: "on-request", experimentalRawEvents: false }, 60000)
  const id = thread.thread.id
  console.log("THREAD", id, "MODEL", thread.model)
  await fs.writeFile(path.join(output, "thread-start.json"), JSON.stringify({ id, model: thread.model, sandbox: thread.sandbox }, null, 2))
  const status = await rpc.request("mcpServerStatus/list", { threadId: id, detail: "toolsAndAuthOnly" }, 60000)
  await fs.writeFile(path.join(output, "mcp-status.json"), JSON.stringify(status, null, 2))
  console.log("MCP_STATUS", JSON.stringify(status).slice(0, 4000))
  await rpc.request("thread/unsubscribe", { threadId: id }).catch(error => console.log("UNSUBSCRIBE", error.message))
} finally {
  await rpc.close()
  await fs.writeFile(path.join(output, "server.stderr.log"), logs.join(""))
}
