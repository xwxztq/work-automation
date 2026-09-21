import test from "node:test"
import assert from "node:assert/strict"
import { RequestBroker } from "./request-broker.mjs"
import { StdioRpc } from "./rpc.mjs"

test("server tool calls can wait for a client response without deadlocking the RPC request", async () => {
  let nextRequest
  const shown = new Promise(resolve => { nextRequest = resolve })
  const broker = new RequestBroker({ emit: nextRequest })
  const server = `
    const rl = require('node:readline').createInterface({input:process.stdin});
    let clientRequest;
    rl.on('line', line => {
      const msg=JSON.parse(line);
      if (msg.method==='tool/call') {
        clientRequest=msg.id;
        console.log(JSON.stringify({jsonrpc:'2.0',id:100,method:'mcpServer/elicitation/request',params:{message:'Use the test app?'}}));
      } else if(msg.id===100) {
        console.log(JSON.stringify({jsonrpc:'2.0',id:clientRequest,result:{decision:msg.result.action}}));
      }
    });`
  const rpc = new StdioRpc(process.execPath, ["-e", server], { onRequest: message => broker.request(message) })
  try {
    const call = rpc.request("tool/call")
    const message = await shown
    assert.equal(message.method, "mcpServer/elicitation/request")
    broker.respond(message.id, { action: "decline", content: null })
    assert.deepEqual(await call, { decision: "decline" })
  } finally { broker.close(); await rpc.close() }
})

test("responses require an existing ID and explicit result; closing rejects pending requests", async () => {
  const broker = new RequestBroker({ emit() {} })
  assert.throws(() => broker.respond(10, { action: "accept" }), /No pending/)
  const pending = broker.request({ id: 10, method: "item/tool/requestUserInput" })
  assert.throws(() => broker.respond(10, undefined), /explicit/)
  const rejected = assert.rejects(pending, /closed without a response/)
  broker.close()
  await rejected
  await assert.rejects(broker.request({ id: 11 }), /client closed/)
})
