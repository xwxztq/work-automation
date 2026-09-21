import http from "node:http"

const html = `<!doctype html><meta charset="utf-8"><title>WorkAutomation Browser Probe</title>
<style>body{font:20px system-ui;max-width:640px;margin:60px auto}input,button{font:inherit;padding:10px}output{display:block;margin-top:24px}</style>
<h1>WorkAutomation Browser Probe</h1>
<label for="value">Probe value</label><input id="value"><button id="record">Record value</button>
<output id="result">Waiting for input</output>
<script>document.querySelector('#record').onclick=()=>document.querySelector('#result').textContent='Recorded: '+document.querySelector('#value').value</script>`
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(html)
})
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`))
process.on("SIGTERM", () => server.close())
process.on("SIGINT", () => server.close())
