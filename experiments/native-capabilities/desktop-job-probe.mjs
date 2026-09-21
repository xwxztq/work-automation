import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"

// A disposable local dispatcher. The desktop task pulls work through ordinary
// HTTP; this does not connect to private desktop pipes or impersonate a task.
const output = process.argv[2]
if (!output || !path.isAbsolute(output)) throw new Error("Provide an absolute output directory")
await fs.mkdir(output, { recursive: true, mode: 0o700 })
const token = randomBytes(32).toString("hex")
const uiNonce = randomBytes(24).toString("hex")
const jobId = randomUUID()
const expectedValue = `Desktop queue 中文 ${jobId.slice(0, 8)}`
let state = { jobId, status: "pending", workerTaskId: null, expectedValue, interaction: null, result: null }
const persist = () => fs.writeFile(path.join(output, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 })
let operations = Promise.resolve()
function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}
async function body(req) {
  let raw = ""
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > 16384) throw new Error("Request too large")
  }
  return JSON.parse(raw || "{}")
}
async function handle(req, res) {
  if (req.url === "/fixture" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    res.end(`<!doctype html><meta charset="utf-8"><title>Desktop Dispatch Probe</title>
      <style>body{font:20px system-ui;margin:60px}input,button{font:inherit;padding:10px}output{display:block;margin-top:24px}</style>
      <h1>Desktop Dispatch Probe</h1><label for="value">Test value</label><input id="value"><button id="record">Record value</button><output id="result">Waiting</output>
      <script>document.querySelector('#record').onclick=async()=>{const value=document.querySelector('#value').value;const r=await fetch('/ui-evidence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce:${JSON.stringify(uiNonce)},value})});document.querySelector('#result').textContent=r.ok?'Recorded: '+value:'Not recorded';}</script>`)
    return
  }
  if (req.url === "/ui-evidence" && req.method === "POST") {
    const input = await body(req)
    if (input.nonce !== uiNonce || input.value !== expectedValue || state.status !== "running") return reply(res, 400, { error: "Unexpected test interaction" })
    state.interaction = { value: input.value, recordedAt: new Date().toISOString() }
    await persist()
    return reply(res, 200, { recorded: true })
  }
  if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { error: "Unauthorized" })
  if (req.url === "/job" && req.method === "GET") return reply(res, 200, state)
  if (req.url === "/claim" && req.method === "POST") {
    const input = await body(req)
    if (typeof input.workerTaskId !== "string" || !input.workerTaskId) return reply(res, 400, { error: "workerTaskId required" })
    if (state.status !== "pending" && !(state.status === "running" && input.workerTaskId === state.workerTaskId)) return reply(res, 409, { error: "Job already claimed or completed" })
    state = { ...state, status: "running", workerTaskId: input.workerTaskId }
    await persist()
    return reply(res, 200, { jobId, expectedValue, fixtureUrl: "/fixture" })
  }
  if (req.url === "/result" && req.method === "POST") {
    const input = await body(req)
    if (state.status !== "running" || input.jobId !== jobId || input.workerTaskId !== state.workerTaskId) return reply(res, 409, { error: "No matching running job" })
    if (!state.interaction || input.observedValue !== expectedValue || input.hostCommandExitCode !== 0 || typeof input.reportPath !== "string") return reply(res, 400, { error: "Test evidence incomplete" })
    state = { ...state, status: "completed", result: input, completedAt: new Date().toISOString() }
    await persist()
    return reply(res, 200, { accepted: true, jobId })
  }
  reply(res, 404, { error: "Unknown endpoint" })
}
const server = http.createServer((req, res) => {
  operations = operations.then(() => handle(req, res)).catch(error => reply(res, 400, { error: error.message }))
})
await persist()
server.listen(0, "127.0.0.1", async () => {
  const manifestPath = path.join(output, "manifest.json")
  await fs.writeFile(manifestPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token, jobId }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ manifestPath, jobId }))
})
process.on("SIGTERM", () => server.close())
process.on("SIGINT", () => server.close())
