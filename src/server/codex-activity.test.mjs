import test from "node:test"
import assert from "node:assert/strict"

import { summarizeCodexRun } from "./codex-activity.mjs"

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
