import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { chromium } from "playwright-core"
import { startBrowserSession, localPreviewUrl } from "./browser-session.mjs"
import { buildCodexPermissionBoundary, buildCodexSandboxArgs, buildCodexRuntimeReadPaths, resolveExecutableReadPaths } from "./codex-permissions.mjs"
import { resolveExecutable } from "./executable.mjs"

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wauto-browser-test-"))
  const runDir = path.join(root,"run")
  const cwd = path.join(root,"workspace")
  await fs.mkdir(cwd)
  const calls = []
  let route, launchOptions
  const page = { setDefaultTimeout(){}, on(){}, url:()=>"http://127.0.0.1:9999/", title:async()=>"Fixture", viewportSize:()=>({width:1280,height:720}),
    locator:selector=>({innerText:async()=>"Fixture text", click:async()=>calls.push(["click",selector]),fill:async value=>calls.push(["fill",selector,value])}),
    goto:async url=>calls.push(["open",url]),keyboard:{press:async key=>calls.push(["press",key])},
    mouse:{move:async(...v)=>calls.push(["move",...v]),down:async()=>calls.push(["down"]),up:async()=>calls.push(["up"])},screenshot:async()=>Buffer.alloc(200,7) }
  const fakeLaunch = async opts => {launchOptions=opts;return {newContext:async()=>({route:async(_,fn)=>{route=fn},newPage:async()=>page,on(){}}),close:async()=>calls.push(["close"])}}
  const session = await startBrowserSession({runDir,cwd,runId:"test-run",launch:options.launch || fakeLaunch})
  t.after(async()=>{await session.close();await fs.rm(root,{recursive:true,force:true})})
  const credentials = JSON.parse(await fs.readFile(session.sessionPath,"utf8"))
  async function request(input, headers = {}) {
    const response = await fetch(credentials.endpoint,{method:"POST",headers:{Authorization:`Bearer ${credentials.token}`,...headers},body:JSON.stringify(input)})
    return {status:response.status,body:await response.json()}
  }
  return {root,runDir,cwd,session,request,credentials,calls,page,get route(){return route},get launchOptions(){return launchOptions}}
}

test("browser preview URL rejects remote hosts, credentials and file navigation",()=>{
  for(const url of ["file:///etc/passwd","https://example.com","http://user:pass@localhost:3000","http://127.0.0.1.evil.test/"]) assert.throws(()=>localPreviewUrl(url))
  assert.equal(localPreviewUrl("http://127.0.0.1:3000/app").port,"3000")
})

test("browser capability authenticates, constrains actions and saves bounded run artifacts",async t=>{
  const f=await fixture(t)
  assert.equal((await f.request({action:"state"},{Authorization:"wrong"})).status,403)
  assert.equal((await f.request({action:"state"},{Origin:"http://evil.test"})).status,403)
  assert.equal((await f.request({action:"evaluate",script:"process.exit()"})).status,400)
  assert.equal((await f.request({action:"open",url:"file:///etc/passwd"})).status,400)
  assert.equal((await f.request({action:"open",url:"http://127.0.0.1:9999/"})).status,200)
  assert.equal(f.launchOptions.chromiumSandbox,true)
  assert.equal(f.launchOptions.env.LINEAR_API_KEY,undefined)
  assert.equal(f.launchOptions.env.OPENAI_API_KEY,undefined)
  assert.notEqual(f.launchOptions.env.HOME,os.homedir())
  await f.request({action:"press",key:"Space"})
  await f.request({action:"drag",from:[10,20],to:[40,50]})
  assert.ok(f.calls.some(([action])=>action==="up"))
  const result=await f.request({action:"screenshot",filePath:"../../escape.jpg"})
  assert.equal(result.status,200)
  assert.match(result.body.filePath,/^browser\/\d{3}-[a-f0-9]+\.jpg$/)
  assert.equal((await fs.stat(path.join(f.runDir,result.body.filePath))).size,200)
  assert.equal(result.body.runId,"test-run")
  let aborted=false
  await f.route({request:()=>({url:()=>"https://evil.test/",isNavigationRequest:()=>true}),abort:()=>{aborted=true},continue:()=>{}})
  assert.equal(aborted,true)
})

test("browser drag releases pointer after a failed move",async t=>{
  const f=await fixture(t);await f.request({action:"open",url:"http://localhost:9999/"})
  let moves=0;f.page.mouse.move=async()=>{if(++moves===2)throw new Error("Move failed")}
  assert.equal((await f.request({action:"drag",from:[10,20],to:[40,50]})).status,400)
  assert.ok(f.calls.some(([action])=>action==="up"))
})

test("browser context startup failure closes the partial browser and permits recovery", async t => {
  let attempts = 0, closed = 0, f
  f = await fixture(t, {
    launch: async () => ({
      async newContext() {
        if (++attempts === 1) throw new Error("Context startup failed")
        return { async route() {}, async newPage() { return f.page }, on() {} }
      },
      async close() { closed++ },
    }),
  })
  assert.equal((await f.request({ action: "open", url: "http://localhost:9999/" })).status, 400)
  assert.equal(closed, 1)
  assert.equal((await f.request({ action: "open", url: "http://localhost:9999/" })).status, 200)
  await f.session.close()
  await assert.rejects(fs.access(f.session.sessionPath))
})

test("real sandboxed browser client gets a screenshot without access to workspace secrets",async t=>{
  if(process.platform!=="darwin")return t.skip("macOS sandbox integration")
  const codex=await resolveExecutable("codex",{path:process.env.PATH})
  if(!codex)return t.skip("Codex unavailable")
  // Explicit opt-in avoids requiring a downloaded browser for ordinary unit CI.
  if(process.env.WAUTO_BROWSER_LIVE_TEST!=="1")return t.skip("Set WAUTO_BROWSER_LIVE_TEST=1 for real browser and sandbox test")
  const f=await fixture(t,{launch:options=>chromium.launch(options)})
  const http=await import("node:http")
  const server=http.createServer((_,res)=>res.end('<html><body><h1>Browser fixture</h1><button id="go" onclick="this.textContent=\'Clicked\'">Click</button></body></html>'))
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  await fs.writeFile(path.join(f.cwd,".env.local"),"PRIVATE_SENTINEL")
  const client=path.resolve("src/server/browser-client.mjs")
  const home=path.join(f.root,"home");await fs.mkdir(home)
  const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:home}
  const boundary=buildCodexPermissionBoundary({stage:"part3",cwd:f.cwd,projectPath:f.cwd,runtimeRoot:f.root,runDir:f.runDir,finalPath:path.join(f.runDir,"final.txt"),runtimeReadPaths:buildCodexRuntimeReadPaths(env),launcherReadPaths:[client,...await resolveExecutableReadPaths(process.execPath),...await resolveExecutableReadPaths(codex)],runtimeWritePaths:[home]})
  async function sandbox(command,args){return await new Promise((resolve,reject)=>{const child=spawn(codex,buildCodexSandboxArgs({boundary,cwd:f.cwd,targetBin:command,targetArgs:args}),{env,cwd:f.cwd});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}))})}
  const open=await sandbox(process.execPath,[client,f.session.sessionPath,JSON.stringify({action:"open",url:`http://127.0.0.1:${server.address().port}/`})])
  assert.equal(open.code,0,open.stderr+open.stdout)
  const click=await sandbox(process.execPath,[client,f.session.sessionPath,JSON.stringify({action:"click",selector:"#go"})])
  assert.match(click.stdout,/Clicked/)
  const shot=await sandbox(process.execPath,[client,f.session.sessionPath,JSON.stringify({action:"screenshot"})])
  assert.equal(shot.code,0,shot.stderr+shot.stdout)
  const capture=JSON.parse(shot.stdout);assert.ok(capture.bytes>1000&&capture.bytes<=65536)
  const deny=await sandbox('/bin/cat',[path.join(f.cwd,'.env.local')]);assert.notEqual(deny.code,0);assert.doesNotMatch(deny.stdout,/PRIVATE_SENTINEL/)
  const write=await sandbox(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(path.join(f.runDir,capture.filePath))},'tamper')`]);assert.notEqual(write.code,0)
})
