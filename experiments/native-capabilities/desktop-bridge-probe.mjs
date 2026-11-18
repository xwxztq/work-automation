import fs from "node:fs/promises"
import path from "node:path"
import { StdioRpc } from "./rpc.mjs"

// Read-only experiment against the existing desktop host. Supply the real
// independent thread ID, never copy the desktop task's identity into it.
const [serverPath, threadId, output] = process.argv.slice(2)
if (!serverPath || !threadId || !output || !process.env.CODEX_APP_TOOLS_PIPE_PATH) {
  throw new Error("Usage: desktop-bridge-probe.mjs <installed-server.mjs> <real-independent-thread-id> <output-directory>; desktop host pipe required")
}
await fs.mkdir(output, { recursive: true })
// Use the plugin's own launcher so it selects the runtime provided by the
// desktop host. An arbitrary system Node is not equivalent to that runtime.
const launcher = path.join(path.dirname(serverPath), "scripts/launch_codex_app_tools_mcp")
const rpc = new StdioRpc(launcher, [serverPath], { cwd: path.dirname(serverPath) })
try {
  await rpc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "work_automation_desktop_bridge_probe", version: "0.1" } })
  rpc.notify("notifications/initialized")
  const inventory = await rpc.request("tools/list")
  await fs.writeFile(path.join(output, "tools.json"), JSON.stringify(inventory, null, 2))
  console.log("TOOLS", inventory.tools.map(tool => tool.name))
  const selected = inventory.tools.find(tool => tool.name === "list_projects")
  if (!selected) throw new Error("Desktop host does not expose list_projects")
  const result = await rpc.request("tools/call", { name: selected.name, arguments: {}, _meta: { "x-codex-turn-metadata": { thread_id: threadId } } }, 45000)
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2))
  console.log("RESULT", JSON.stringify(result).slice(0, 2500))
} catch (error) {
  await fs.writeFile(path.join(output, "error.json"), JSON.stringify({ message: error.message }, null, 2))
  console.error("BRIDGE_ERROR", error.message)
  process.exitCode = 1
} finally { await rpc.close() }
