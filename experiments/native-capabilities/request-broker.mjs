export class RequestBroker {
  constructor({ emit, timeoutMs = 600000 }) {
    this.emit = emit
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.closed = false
  }

  request(message) {
    if (this.closed) return Promise.reject(new Error("Interactive client closed"))
    if (this.pending.has(message.id)) return Promise.reject(new Error("Duplicate server request ID"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error(`Interactive response timed out: ${message.method}`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(message.id, { resolve, reject, timer })
      this.emit(message)
    })
  }

  respond(id, result) {
    const pending = this.pending.get(id)
    if (!pending) throw new Error(`No pending server request: ${id}`)
    if (result === undefined) throw new Error("An explicit response result is required")
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }

  close() {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Interactive client closed without a response"))
    }
    this.pending.clear()
  }
}
