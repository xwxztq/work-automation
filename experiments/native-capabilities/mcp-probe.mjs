import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { StdioRpc } from "./rpc.mjs"

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
const command = path.join(codexHome, "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient")
const output = process.argv[2]
if (!output) throw new Error("Usage: node mcp-probe.mjs <output-directory> [app-id]")
await fs.mkdir(output, { recursive: true })
const rpc = new StdioRpc(command, ["mcp"], {
  onStderr: text => process.stderr.write(text),
  onRequest: async message => {
    console.log("SERVER_REQUEST", JSON.stringify(message))
    // The user authorized this independent test application. Grant only this
    // request once; never save an always-allow decision or grant other apps.
    if (process.argv.includes("--allow-fixture") && message.method === "elicitation/create"
      && message.params?.message === "Allow ChatGPT to use NativeCapabilityProbe?") {
      return { action: "accept", content: {} }
    }
    throw new Error("Probe requires interactive approval; no automatic approval supplied")
  },
})
try {
  const initialized = await rpc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "work-automation-independent-probe", version: "0.1" } })
  rpc.notify("notifications/initialized")
  const tools = await rpc.request("tools/list")
  await fs.writeFile(path.join(output, "mcp-tools.json"), JSON.stringify({ initialized, ...tools }, null, 2))
  console.log("TOOLS", tools.tools.map(t => t.name).join(", "))
  const app = process.argv[3]
  const result = await rpc.request("tools/call", app ? { name: "get_app_state", arguments: { app } } : { name: "list_apps", arguments: {} }, 45000)
  let n = 0
  const content = []
  for (const block of result.content || []) {
    if (block.type === "image") {
      const file = `screenshot-${++n}.${block.mimeType === "image/jpeg" ? "jpg" : "png"}`
      await fs.writeFile(path.join(output, file), Buffer.from(block.data, "base64"))
      content.push({ type: "image", file })
    } else content.push(block)
  }
  await fs.writeFile(path.join(output, "mcp-result.json"), JSON.stringify({ ...result, content }, null, 2))
  console.log("RESULT", app || "app inventory", "isError", result.isError || false, "blocks", content.length)
  if (app || result.isError) console.log(JSON.stringify(content).slice(0, 10000))
} finally { await rpc.close() }
