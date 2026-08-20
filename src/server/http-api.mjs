import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { createLinearClient } from "./linear-client.mjs"
import {
  loadConfig,
  redactConfig,
  saveConfig,
  validateConfig,
} from "./config.mjs"
import { createCodexActivityPayload } from "./codex-activity.mjs"
import { readAllPrompts, readPrompt, writePrompt } from "./prompts.mjs"
import { createLinearStatusHealthChecker } from "./status-health.mjs"

export function createHttpApi({
  configPath,
  rootDir = process.cwd(),
  staticRootDir = rootDir,
  scheduler,
  store,
  setupManager = null,
  dev = false,
  linearStatusHealthChecker = createLinearStatusHealthChecker(),
}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost")
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, {
          configPath,
          rootDir,
          scheduler,
          store,
          setupManager,
          linearStatusHealthChecker,
        })
        return
      }
      if (dev) {
        sendJson(res, 404, {
          error: "API 服务已启动，请使用 Vite 开发服务访问前端。",
        })
        return
      }
      await serveStatic(res, url.pathname, staticRootDir)
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

async function handleApi(req, res, url, context) {
  const {
    configPath,
    rootDir,
    scheduler,
    store,
    setupManager,
    linearStatusHealthChecker,
  } = context
  const method = req.method || "GET"
  const parts = url.pathname.split("/").filter(Boolean)

  if (method === "GET" && url.pathname === "/api/setup/status") {
    if (!setupManager) {
      sendJson(res, 501, { error: "当前服务未启用首次配置功能。" })
      return
    }
    sendJson(res, 200, await setupManager.status())
    return
  }

  if (method === "POST" && url.pathname === "/api/setup/configure") {
    if (!setupManager) {
      sendJson(res, 501, { error: "当前服务未启用首次配置功能。" })
      return
    }
    try {
      const result = await setupManager.configure(await readBody(req))
      linearStatusHealthChecker.clear()
      if (result.ready) {
        scheduler.start()
      }
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (method === "GET" && url.pathname === "/api/config") {
    const config = await loadConfig(configPath, rootDir)
    sendJson(res, 200, redactConfig(config))
    return
  }

  if (method === "PUT" && url.pathname === "/api/config") {
    const body = await readBody(req)
    try {
      const saved = await saveConfig(configPath, body, rootDir)
      sendJson(res, 200, redactConfig(saved))
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (method === "POST" && url.pathname === "/api/config/validate") {
    const config = await loadConfig(configPath, rootDir)
    sendJson(res, 200, await validateConfig(config, rootDir))
    return
  }

  if (method === "GET" && url.pathname === "/api/linear/status-health") {
    const config = await loadConfig(configPath, rootDir)
    sendJson(
      res,
      200,
      await linearStatusHealthChecker.check(config, {
        force: url.searchParams.get("refresh") === "1",
      }),
    )
    return
  }

  if (method === "GET" && url.pathname === "/api/prompts") {
    const config = await loadConfig(configPath, rootDir)
    sendJson(res, 200, await readAllPrompts(rootDir, config.projects))
    return
  }

  if (method === "GET" && url.pathname === "/api/linear/projects") {
    const config = await loadConfig(configPath, rootDir)
    const apiKey = process.env[config.linear.apiKeyEnv]
    if (!apiKey) {
      sendJson(res, 400, { error: `未设置 ${config.linear.apiKeyEnv}。` })
      return
    }
    const linear = createLinearClient(apiKey)
    sendJson(res, 200, {
      projects: await linear.listProjects(),
    })
    return
  }

  if (method === "PUT" && parts[1] === "prompts" && parts.length === 4) {
    const [, , scope, stage] = parts
    const body = await readBody(req)
    const result = await writePrompt(rootDir, scope, stage, String(body.content || ""))
    sendJson(res, 200, result)
    return
  }

  if (method === "GET" && parts[1] === "prompts" && parts.length === 4) {
    const [, , scope, stage] = parts
    sendJson(res, 200, { content: await readPrompt(rootDir, scope, stage) })
    return
  }

  if (method === "POST" && parts[1] === "projects" && parts[3] === "cancel") {
    const result = await scheduler.cancelProject(parts[2])
    sendJson(res, result.ok ? 200 : 404, result)
    return
  }

  if (method === "GET" && parts[1] === "projects" && parts[3] === "linear-preview") {
    const config = await loadConfig(configPath, rootDir)
    const project = config.projects.find((item) => item.key === parts[2])
    if (!project) {
      sendJson(res, 404, { error: `未知项目: ${parts[2]}` })
      return
    }
    const apiKey = process.env[config.linear.apiKeyEnv]
    if (!apiKey) {
      sendJson(res, 400, { error: `未设置 ${config.linear.apiKeyEnv}。` })
      return
    }
    const linear = createLinearClient(apiKey)
    const preview = await linear.listProjectIssues(project.linearProjectId, 100)
    const counts = {}
    for (const issue of preview.issues) {
      const status = issue.state?.name || "未知"
      counts[status] = (counts[status] || 0) + 1
    }
    sendJson(res, 200, {
      project: {
        id: preview.project.id,
        name: preview.project.name,
        url: preview.project.url,
      },
      counts,
      issues: preview.issues.slice(0, 20).map((issue) => ({
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state?.name,
        updatedAt: issue.updatedAt,
        url: issue.url,
      })),
    })
    return
  }

  if (method === "POST" && url.pathname === "/api/runs/once") {
    if (!(await ensureSetupReady(res, setupManager))) return
    const body = await readBody(req)
    const stage = body.stage || "both"
    const force = Boolean(body.force)
    startManualRunInBackground({ scheduler, store, stage, projectKey: body.projectKey, force })
    sendJson(res, 202, acceptedRunPayload({ stage, projectKey: body.projectKey, force }))
    return
  }

  if (method === "POST" && url.pathname === "/api/runs/issue") {
    if (!(await ensureSetupReady(res, setupManager))) return
    const body = await readBody(req)
    const stage = body.stage || "both"
    const force = Boolean(body.force)
    startManualRunInBackground({ scheduler, store, stage, issueId: body.issueId, projectKey: body.projectKey, force })
    sendJson(res, 202, acceptedRunPayload({ stage, issueId: body.issueId, projectKey: body.projectKey, force }))
    return
  }

  if (method === "POST" && parts[1] === "runs" && parts[2] && parts[3] === "cancel") {
    const result = await scheduler.cancelRun(parts[2])
    sendJson(res, result.ok ? 200 : 404, result)
    return
  }

  if (method === "GET" && url.pathname === "/api/runs") {
    sendJson(
      res,
      200,
      await store.listRunsWithTotal({
        limit: 100,
        projectKey: url.searchParams.get("projectKey") || undefined,
      }),
    )
    return
  }

  if (method === "GET" && parts[1] === "runs" && parts[2]) {
    const run = await store.getRun(parts[2])
    if (!run) {
      sendJson(res, 404, { error: `未找到运行记录: ${parts[2]}` })
      return
    }
    sendJson(res, 200, run)
    return
  }

  if (method === "POST" && url.pathname === "/api/daemon/start") {
    if (!(await ensureSetupReady(res, setupManager))) return
    scheduler.start()
    sendJson(res, 200, await scheduler.status())
    return
  }

  if (method === "POST" && url.pathname === "/api/daemon/stop") {
    scheduler.stop()
    sendJson(res, 200, await scheduler.status())
    return
  }

  if (method === "GET" && url.pathname === "/api/daemon/status") {
    sendJson(res, 200, await scheduler.status())
    return
  }

  if (method === "GET" && url.pathname === "/api/events") {
    sendJson(res, 200, {
      events: await store.listEvents({
        limit: Number(url.searchParams.get("limit") || 200),
        projectKey: url.searchParams.get("projectKey") || undefined,
      }),
    })
    return
  }

  if (method === "GET" && url.pathname === "/api/codex/activity") {
    sendJson(
      res,
      200,
      await createCodexActivityPayload({
        scheduler,
        store,
        projectKey: url.searchParams.get("projectKey") || undefined,
      }),
    )
    return
  }

  sendJson(res, 404, { error: `未找到接口: ${method} ${url.pathname}` })
}

async function ensureSetupReady(res, setupManager) {
  if (!setupManager) {
    return true
  }
  const status = await setupManager.status()
  if (status.ready) {
    return true
  }
  sendJson(res, 409, {
    error: "首次配置尚未完成，不能启动自动执行。",
    setup: status,
  })
  return false
}

function startManualRunInBackground({ scheduler, store, stage, issueId, projectKey, force = false }) {
  void scheduler
    .runOnce(stage, { issueId, projectKey, force })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      await store
        .appendEvent({
          type: "manual-run-error",
          level: "error",
          stage,
          projectKey,
          message,
          data: {
            issueId,
            force,
          },
        })
        .catch(() => {})
    })
}

function acceptedRunPayload({ stage, issueId, projectKey, force = false }) {
  return {
    accepted: true,
    stage,
    projectKey: projectKey || null,
    issueId: issueId || null,
    force,
    submittedAt: new Date().toISOString(),
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(payload, null, 2))
}

async function serveStatic(res, pathname, staticRootDir) {
  const distDir = path.join(staticRootDir, "dist")
  const requested = pathname === "/" ? "/index.html" : pathname
  const filePath = path.join(distDir, requested)
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(distDir)) {
    sendJson(res, 403, { error: "无权访问" })
    return
  }
  try {
    const content = await fs.readFile(resolved)
    res.writeHead(200, {
      "Content-Type": mimeType(resolved),
      "Cache-Control": resolved.endsWith("index.html") ? "no-store" : "public, max-age=31536000",
    })
    res.end(content)
  } catch (error) {
    if (error?.code === "ENOENT") {
      const index = await fs.readFile(path.join(distDir, "index.html"))
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(index)
      return
    }
    throw error
  }
}

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8"
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8"
  if (filePath.endsWith(".svg")) return "image/svg+xml"
  if (filePath.endsWith(".png")) return "image/png"
  return "application/octet-stream"
}
