import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { randomBytes, createHash, timingSafeEqual } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const execFileAsync = promisify(execFile)
const CLIENT_PATH = fileURLToPath(new URL("./browser-client.mjs", import.meta.url))
const MAX_BODY = 16 * 1024
const MAX_IMAGE = 64 * 1024

export function localPreviewUrl(value) {
  const url = new URL(String(value))
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password) {
    throw new Error("浏览器仅接受无凭据的本机 HTTP(S) 预览地址。")
  }
  return url
}

function coordinate(value) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(n => !Number.isFinite(n) || n < 0 || n > 4096)) {
    throw new Error("坐标必须为 0 到 4096 范围内的 [x,y]。")
  }
  return value
}

export async function startBrowserSession({ runDir, cwd, runId, launch = options => chromium.launch(options) }) {
  // This directory is read-only to the code agent, unlike review/. Keep trusted
  // browser artifacts here so a workspace symlink cannot redirect host writes.
  const artifactDir = path.join(runDir, "browser")
  await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 })
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "wauto-browser-"))
  const token = randomBytes(32).toString("hex")
  const sessionPath = path.join(runDir, "browser-session.json")
  let browser, context, page, origin, busy = false, closed = false
  let sequence = 0
  const errors = []
  async function revision() {
    try {
      const git = "git"
      const options = { cwd, timeout: 5000 }
      const commit = (await execFileAsync(git, ["rev-parse", "HEAD"], options)).stdout.trim()
      const dirty = Boolean((await execFileAsync(git, ["status", "--porcelain"], options)).stdout.trim())
      return { commit, workingTreeDirty: dirty }
    } catch { return { commit: null, workingTreeDirty: null } }
  }

  async function ensureBrowser() {
    if (browser) return
    // No Linear, OpenAI, MCP credentials or personal browser profile are inherited.
    const env = Object.fromEntries(["PATH", "SYSTEMROOT", "WINDIR", "LANG", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]
      .filter(key => process.env[key]).map(key => [key, process.env[key]]))
    Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch })
    try {
      browser = await launch({ headless: true, chromiumSandbox: true, timeout: 15000, env })
      context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: false, serviceWorkers: "block" })
      await context.route("**/*", async route => {
        const request = route.request()
        let url
        try { url = new URL(request.url()) } catch { return route.abort() }
        // External HTTPS assets (for example Three.js CDN) are allowed, but no
        // file URLs or off-origin document navigation, redirects or popups.
        if (!['http:', 'https:'].includes(url.protocol) ||
            (request.isNavigationRequest() && url.origin !== origin)) return route.abort()
        return route.continue()
      })
      page = await context.newPage()
      page.setDefaultTimeout(5000)
      page.on("pageerror", error => { if (errors.length < 30) errors.push(String(error.message).slice(0,1000)) })
      context.on("page", other => { if (other !== page) void other.close().catch(() => {}) })
    } catch (error) {
      await browser?.close().catch(() => {})
      browser = context = page = undefined
      throw error
    }
  }

  async function state() {
    if (!page) return { ready: true, opened: false }
    return { url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 12000), errors: [...errors] }
  }

  async function execute(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求必须是对象。")
    const action = input.action
    if (!["open", "state", "click", "fill", "press", "drag", "wait", "screenshot"].includes(action)) throw new Error("不支持的浏览器操作。")
    if (action === "open") {
      const url = localPreviewUrl(input.url)
      origin = url.origin
      await ensureBrowser()
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 15000 })
    } else if (action !== "state") {
      if (!page) throw new Error("请先 open 本机预览页面。")
      if (["click", "fill"].includes(action)) {
        if (typeof input.selector !== "string" || !input.selector || input.selector.length > 1000) throw new Error("需要有效的 CSS selector。")
        const locator = page.locator(input.selector)
        if (action === "click") await locator.click()
        else {
          if (typeof input.value !== "string" || input.value.length > 5000) throw new Error("输入内容过长。")
          await locator.fill(input.value)
        }
      } else if (action === "press") {
        if (typeof input.key !== "string" || input.key.length > 80) throw new Error("需要有效的按键。")
        await page.keyboard.press(input.key)
      } else if (action === "drag") {
        const [x1,y1] = coordinate(input.from), [x2,y2] = coordinate(input.to)
        await page.mouse.move(x1,y1)
        await page.mouse.down()
        try { await page.mouse.move(x2,y2,{steps:20}) } finally { await page.mouse.up() }
      } else if (action === "wait") {
        if (!Number.isInteger(input.ms) || input.ms < 0 || input.ms > 5000) throw new Error("等待范围为 0 到 5000 毫秒。")
        await new Promise(resolve => setTimeout(resolve,input.ms))
      } else if (action === "screenshot") {
        if (sequence >= 32) throw new Error("本次运行最多保存 32 张截图。")
        const before = await revision()
        let bytes
        for (const quality of [70,50,30,15]) {
          bytes = await page.screenshot({ type: "jpeg", quality, timeout: 10000 })
          if (bytes.length <= MAX_IMAGE) break
        }
        if (bytes.length > MAX_IMAGE) throw new Error("截图超过 64 KiB，请简化页面后重试。")
        const fileName = `${String(++sequence).padStart(3,"0")}-${randomBytes(4).toString("hex")}.jpg`
        await fs.writeFile(path.join(artifactDir,fileName),bytes,{flag:"wx",mode:0o600})
        const after = await revision()
        const result = { filePath: `browser/${fileName}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...before, revisionChangedDuringCapture: before.commit !== after.commit || before.workingTreeDirty !== after.workingTreeDirty, runId, url: page.url(), viewport: page.viewportSize(), capturedAt: new Date().toISOString() }
        await fs.appendFile(path.join(artifactDir,"screenshots.jsonl"),JSON.stringify(result)+"\n",{mode:0o600})
        return result
      }
    }
    return state()
  }

  const server = http.createServer(async (req,res) => {
    const respond = (code,body) => { res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(body)) }
    const supplied = Buffer.from(String(req.headers.authorization || ""))
    const expected = Buffer.from(`Bearer ${token}`)
    if (req.method !== "POST" || req.url !== "/action" || req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) return respond(403,{error:"Forbidden"})
    if (busy || closed) return respond(409,{error:"Browser session busy or closed"})
    busy = true
    try {
      let body = ""
      for await (const chunk of req) {
        body += chunk.toString()
        if (Buffer.byteLength(body) > MAX_BODY) throw new Error("请求超过 16 KiB。")
      }
      const input = JSON.parse(body)
      const result = await execute(input)
      await fs.appendFile(path.join(artifactDir,"actions.jsonl"),JSON.stringify({action:input.action,at:new Date().toISOString(),ok:true})+"\n",{mode:0o600})
      respond(200,result)
    } catch (error) {
      // Never echo the session token or the browser environment.
      const message = String(error.message).replaceAll(token,"[REDACTED]").slice(0,3000)
      respond(400,{error:message})
    } finally { busy = false }
  })
  server.requestTimeout = 20000
  server.headersTimeout = 10000
  try {
    await new Promise((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",resolve)})
    await fs.writeFile(sessionPath,JSON.stringify({endpoint:`http://127.0.0.1:${server.address().port}/action`,token}),{flag:"wx",mode:0o600})
  } catch (error) {server.close();await fs.rm(scratch,{recursive:true,force:true});throw error}
  return {
    sessionPath,
    guidance: `\n本次运行提供服务端浏览器（独立临时浏览器配置，保留 Chromium 沙箱）：\n- GUI 验收优先使用此工具，不要在 Codex 文件沙箱里自行启动桌面 Chrome。工具只支持本机 HTTP(S) 预览；不支持任意 JavaScript 执行、文件上传或读取个人浏览器配置。\n- 调用：${JSON.stringify(process.execPath)} ${JSON.stringify(CLIENT_PATH)} ${JSON.stringify(sessionPath)} '<JSON>'\n- 操作：{"action":"open","url":"http://127.0.0.1:端口/"}；{"action":"state"}；{"action":"click","selector":"#id"}；{"action":"fill","selector":"input","value":"内容"}；{"action":"press","key":"Space"}；{"action":"drag","from":[100,100],"to":[200,200]}；{"action":"wait","ms":1000}；{"action":"screenshot"}。\n- screenshot 返回当前 run 内的 filePath、SHA-256、实现提交、页面地址和视口，可用图片读取工具检查。图片已经小于 64 KiB，阶段三可直接在 comment.create.payload.images 中引用；最多选择四张，长正文时请减少图片数量。截图保存在只读 browser/，不要改写截图或 manifest。\n- 先启动项目本机预览，再进行实际操作和截图，记录动作及观察结果，不能凭截图存在推断交互通过。若返回浏览器缺失，请报告环境阻塞，并提示在服务宿主运行 npx --yes playwright-core@1.61.1 install chromium --only-shell；不要反复自行安装或重试 Chrome。\n- browser-session.json 是短期运行凭据，不得输出、加入评论或复制到产物。\n`,
    async close() {
      closed = true
      server.closeAllConnections()
      await new Promise(resolve=>server.close(resolve))
      await browser?.close().catch(()=>{})
      await fs.rm(sessionPath,{force:true})
      await fs.rm(scratch,{recursive:true,force:true,maxRetries:2}).catch(()=>{})
    },
  }
}
