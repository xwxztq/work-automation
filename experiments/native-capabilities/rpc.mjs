import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

export class StdioRpc {
  constructor(command, args, { env = process.env, cwd, onNotification = () => {}, onRequest, onStderr = () => {} } = {}) {
    this.pending = new Map()
    this.sequence = 0
    this.child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] })
    this.child.stderr.on("data", data => onStderr(String(data)))
    this.child.stdin.on("error", error => this.rejectAll(error))
    this.child.on("error", error => this.rejectAll(error))
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.rejectAll(new Error(`RPC process exited: ${code ?? signal}`))
      resolve({ code, signal })
    }))
    createInterface({ input: this.child.stdout }).on("line", async line => {
      let value
      try { value = JSON.parse(line) } catch { return }
      if (value.method && value.id != null) {
        try {
          if (!onRequest) throw new Error(`Unhandled server request: ${value.method}`)
          this.send({ id: value.id, result: await onRequest(value) })
        } catch (error) {
          this.send({ id: value.id, error: { code: -32603, message: error.message } })
        }
      } else if (value.method) onNotification(value)
      else {
        const pending = this.pending.get(value.id)
        if (!pending) return
        this.pending.delete(value.id)
        clearTimeout(pending.timer)
        if (value.error) pending.reject(new Error(JSON.stringify(value.error)))
        else pending.resolve(value.result)
      }
    })
  }
  send(value) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n") }
  notify(method, params) { this.send({ method, ...(params ? { params } : {}) }) }
  request(method, params = {}, timeout = 30000) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }
  rejectAll(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
  }
  async close() {
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 1000)
    const force = setTimeout(() => this.child.kill("SIGKILL"), 3000)
    try { return await this.closed } finally { clearTimeout(timer); clearTimeout(force) }
  }
}
