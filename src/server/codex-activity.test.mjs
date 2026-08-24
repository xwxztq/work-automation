import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createCodexActivityPayload,
  createCodexActivityReader,
  summarizeCodexRun,
} from "./codex-activity.mjs"
import { createRunStore } from "./run-store.mjs"

const baseRun = {
  id: "run-1",
  projectKey: "demo",
  stage: "part2",
  issueIdentifier: "DEMO-1",
  issueTitle: "Build activity panel",
  status: "running",
  createdAt: "2026-05-24T00:00:00.000Z",
  updatedAt: new Date().toISOString(),
  codexStarted: true,
  codexPid: 1234,
}

function runWithStdout(stdout, patch = {}) {
  return summarizeCodexRun(
    {
      ...baseRun,
      stdout,
      ...patch,
    },
    { stdoutMtimeMs: Date.now() },
  )
}

test("summarizes active command execution", () => {
  const summary = runWithStdout(
    [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "/bin/zsh -lc 'npm run typecheck'",
          status: "in_progress",
        },
      }),
    ].join("\n"),
  )

  assert.equal(summary.activityKind, "command")
  assert.equal(summary.activityLabel, "跑命令")
  assert.equal(summary.activityMotion, "running")
  assert.equal(summary.activityTool, "test")
  assert.match(summary.detail, /npm run typecheck/)
})

test("classifies command motion and tool details", () => {
  const cases = [
    ["git status --short", "reading", "git"],
    ["rg -n \"Codex\"", "reading", "search"],
    ["pnpm build", "running", "test"],
    ["node --test src/server/codex-activity.test.mjs", "running", "test"],
  ]

  for (const [command, motion, tool] of cases) {
    const summary = runWithStdout(
      JSON.stringify({
        type: "item.started",
        item: {
          id: `item_${command}`,
          type: "command_execution",
          command: `/bin/zsh -lc '${command}'`,
          status: "in_progress",
        },
      }),
    )

    assert.equal(summary.activityKind, "command")
    assert.equal(summary.activityMotion, motion)
    assert.equal(summary.activityTool, tool)
  }
})

test("summarizes active mcp tool call", () => {
  const summary = runWithStdout(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "mcp_tool_call",
        server: "linear",
        tool: "get_issue",
        status: "in_progress",
      },
    }),
  )

  assert.equal(summary.activityKind, "tool")
  assert.equal(summary.activityMotion, "reading")
  assert.equal(summary.activityTool, "linear")
  assert.equal(summary.detail, "linear.get_issue")
})

test("classifies linear write tools as typing", () => {
  for (const tool of ["save_comment", "save_issue"]) {
    const summary = runWithStdout(
      JSON.stringify({
        type: "item.started",
        item: {
          id: `item_${tool}`,
          type: "mcp_tool_call",
          server: "linear",
          tool,
          status: "in_progress",
        },
      }),
    )

    assert.equal(summary.activityKind, "tool")
    assert.equal(summary.activityMotion, "typing")
    assert.equal(summary.activityTool, "linear")
  }
})

test("summarizes completed file changes as recent writing activity", () => {
  const summary = runWithStdout(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "file_change",
        changes: [{ path: "/Users/me/project/src/App.tsx", kind: "update" }],
        status: "completed",
      },
    }),
  )

  assert.equal(summary.activityKind, "writing")
  assert.equal(summary.activityMotion, "typing")
  assert.equal(summary.activityTool, "edit")
  assert.match(summary.detail, /src\/App\.tsx/)
})

test("summarizes todo list updates", () => {
  const summary = runWithStdout(
    JSON.stringify({
      type: "item.updated",
      item: {
        id: "item_1",
        type: "todo_list",
        items: [
          { text: "Read files", completed: true },
          { text: "Patch UI", completed: false },
        ],
      },
    }),
  )

  assert.equal(summary.activityKind, "todo")
  assert.equal(summary.activityMotion, "typing")
  assert.equal(summary.activityTool, "todo")
  assert.match(summary.detail, /1\/2 完成/)
})

test("summarizes web search and ignores partial jsonl", () => {
  const summary = runWithStdout(
    `${JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "web_search",
        query: "Pixel Agents canvas",
      },
    })}\n{"type":"item.started"`,
  )

  assert.equal(summary.activityKind, "searching")
  assert.equal(summary.activityMotion, "reading")
  assert.equal(summary.activityTool, "search")
  assert.match(summary.detail, /Pixel Agents/)
})

test("summarizes errors as waiting activity", () => {
  const summary = runWithStdout(JSON.stringify({ type: "error", message: "Reconnecting... 2/5" }))

  assert.equal(summary.activityKind, "waiting")
  assert.equal(summary.activityMotion, "waiting")
  assert.equal(summary.activityTool, "other")
  assert.match(summary.detail, /Reconnecting/)
})

test("empty stdout falls back to booting without codex pid", () => {
  const summary = runWithStdout("", { codexPid: null, codexStarted: false, startupError: null })

  assert.equal(summary.activityKind, "booting")
  assert.equal(summary.activityMotion, "waiting")
})

test("completed statuses override stdout activity", () => {
  const summary = runWithStdout("", {
    status: "succeeded",
    final: "All done",
    exitCode: 0,
  })

  assert.equal(summary.activityKind, "done")
  assert.equal(summary.activityMotion, "success")
  assert.equal(summary.detail, "All done")
})

test("failed and canceled statuses use failure motion", () => {
  const failed = runWithStdout("", {
    status: "failed",
    error: "bad exit",
  })
  const canceled = runWithStdout("", {
    status: "canceled",
    cancelReason: "stopped",
  })

  assert.equal(failed.activityKind, "failed")
  assert.equal(failed.activityMotion, "failure")
  assert.equal(canceled.activityKind, "canceled")
  assert.equal(canceled.activityMotion, "failure")
})

test("activity polling reads a bounded tail once and then parses only appended stdout bytes", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-activity-incremental-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  const store = createRunStore(rootDir)
  const runs = []
  const activeRuns = []
  for (let index = 0; index < 3; index += 1) {
    let run = await store.createRun({
      projectKey: `project-${index}`,
      stage: "part2",
      issue: { id: `issue-${index}`, identifier: `LIV-${index}`, title: `Run ${index}` },
    })
    run = await store.updateRun(run, { codexStarted: true, codexPid: 4000 + index })
    runs.push(run)
    activeRuns.push({
      runId: run.id,
      projectKey: run.projectKey,
      stage: run.stage,
      startedAt: run.createdAt,
      codexPid: run.codexPid,
      issue: { id: run.issueId, identifier: run.issueIdentifier, title: run.issueTitle },
    })
  }

  const oldLine = `${JSON.stringify({
    type: "item.completed",
    item: { id: "old-message", type: "agent_message", text: "historical output" },
  })}\n`
  const commandLine = `${JSON.stringify({
    type: "item.started",
    item: {
      id: "active-command",
      type: "command_execution",
      command: "/bin/zsh -lc 'pnpm test'",
      status: "in_progress",
    },
  })}\n`
  const repeatCount = Math.ceil((2 * 1024 * 1024) / Buffer.byteLength(oldLine))
  const largeStdout = oldLine.repeat(repeatCount) + commandLine
  await fs.writeFile(runs[0].stdoutPath, largeStdout)
  await fs.writeFile(runs[1].stdoutPath, commandLine)
  await fs.writeFile(runs[2].stdoutPath, commandLine)

  const scheduler = {
    async status() {
      return { activeRuns }
    },
  }
  const readLimitBytes = 64 * 1024
  const activityReader = createCodexActivityReader({ readLimitBytes })

  const first = await createCodexActivityPayload({ scheduler, store, activityReader })
  const firstStats = activityReader.inspect(runs[0].id)
  assert.equal(first.agents.length, 3)
  assert.equal(first.agents[0].activityKind, "command")
  assert.equal(first.agents[0].activityTool, "test")
  assert.ok(Buffer.byteLength(largeStdout) >= 2 * 1024 * 1024)
  assert.ok(firstStats.lastBytesRead <= readLimitBytes)
  assert.equal(firstStats.offset, Buffer.byteLength(largeStdout))
  assert.equal(firstStats.parsedOffset, firstStats.offset)

  await createCodexActivityPayload({ scheduler, store, activityReader })
  const unchangedStats = activityReader.inspect(runs[0].id)
  assert.equal(unchangedStats.lastBytesRead, 0)
  assert.equal(unchangedStats.totalBytesRead, firstStats.totalBytesRead)

  const toolEvent = `${JSON.stringify({
    type: "item.started",
    item: {
      id: "active-tool",
      type: "mcp_tool_call",
      server: "linear",
      tool: "get_issue",
      status: "in_progress",
    },
  })}\n`
  const splitAt = Math.floor(toolEvent.length / 2)
  const firstHalf = toolEvent.slice(0, splitAt)
  const secondHalf = toolEvent.slice(splitAt)
  await fs.appendFile(runs[0].stdoutPath, firstHalf)

  const partial = await createCodexActivityPayload({ scheduler, store, activityReader })
  const partialStats = activityReader.inspect(runs[0].id)
  assert.equal(partial.agents[0].activityKind, "command")
  assert.equal(partialStats.lastBytesRead, Buffer.byteLength(firstHalf))
  assert.equal(partialStats.pendingBytes, Buffer.byteLength(firstHalf))

  await fs.appendFile(runs[0].stdoutPath, secondHalf)
  const appended = await createCodexActivityPayload({ scheduler, store, activityReader })
  const appendedStats = activityReader.inspect(runs[0].id)
  assert.equal(appended.agents[0].activityKind, "tool")
  assert.equal(appended.agents[0].detail, "linear.get_issue")
  assert.equal(appendedStats.lastBytesRead, Buffer.byteLength(secondHalf))
  assert.equal(appendedStats.pendingBytes, 0)
  assert.equal(appendedStats.offset, firstStats.offset + Buffer.byteLength(toolEvent))
})

test("activity reader resets after stdout truncation and recovers after service restart", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-activity-reset-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  const store = createRunStore(rootDir)
  let run = await store.createRun({
    projectKey: "project",
    stage: "part2",
    issue: { id: "issue", identifier: "LIV-1", title: "Reset" },
  })
  run = await store.updateRun(run, { codexStarted: true, codexPid: 4000 })
  const activeRun = {
    runId: run.id,
    projectKey: run.projectKey,
    stage: run.stage,
    startedAt: run.createdAt,
    codexPid: run.codexPid,
    issue: { id: run.issueId, identifier: run.issueIdentifier, title: run.issueTitle },
  }
  const scheduler = { async status() { return { activeRuns: [activeRun] } } }
  const reader = createCodexActivityReader({ readLimitBytes: 4096 })
  await fs.writeFile(run.stdoutPath, `${JSON.stringify({
    type: "item.started",
    item: { id: "old", type: "command_execution", command: `pnpm build ${"x".repeat(2000)}`, status: "in_progress" },
  })}\n`)
  const original = await createCodexActivityPayload({ scheduler, store, activityReader: reader })
  assert.equal(original.agents[0].activityKind, "command")

  const replacement = `${JSON.stringify({
    type: "item.started",
    item: { id: "new", type: "web_search", query: "latest docs", status: "in_progress" },
  })}\n`
  await fs.writeFile(run.stdoutPath, replacement)
  const reset = await createCodexActivityPayload({ scheduler, store, activityReader: reader })
  assert.equal(reset.agents[0].activityKind, "searching")
  assert.match(reset.agents[0].detail, /latest docs/)
  assert.equal(reader.inspect(run.id).resetCount, 1)

  const restartedReader = createCodexActivityReader({ readLimitBytes: 4096 })
  const restarted = await createCodexActivityPayload({
    scheduler,
    store,
    activityReader: restartedReader,
  })
  assert.equal(restarted.agents[0].activityKind, "searching")
  assert.equal(restartedReader.inspect(run.id).resetCount, 0)

  restartedReader.retain([])
  assert.equal(restartedReader.inspect(run.id), null)
})
