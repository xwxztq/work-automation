import test from "node:test"
import assert from "node:assert/strict"

import {
  CODEX_LINEAR_AUTH_FAILURE_KIND,
  CODEX_LINEAR_AUTH_FAILURE_MESSAGE,
  diagnoseCodexLinearAuthFailure,
  isCodexLinearAuthFailureRun,
} from "./linear-auth-diagnostics.mjs"

test("detects structured Linear MCP unauthorized failures", () => {
  const diagnostic = diagnoseCodexLinearAuthFailure({
    stdout: JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "linear",
        tool: "save_comment",
        error: {
          message: "Unauthorized: OAuth token expired. Please log in again.",
        },
      },
    }),
    error: "Codex 退出码为 1",
  })

  assert.equal(diagnostic?.kind, CODEX_LINEAR_AUTH_FAILURE_KIND)
  assert.equal(diagnostic?.message, CODEX_LINEAR_AUTH_FAILURE_MESSAGE)
  assert.equal(diagnostic?.retryable, true)
})

test("detects final messages that tell the user to login Linear MCP again", () => {
  const diagnostic = diagnoseCodexLinearAuthFailure({
    finalText: "mcp__linear.save_issue failed: authorization expired. Run codex mcp login linear and retry.",
  })

  assert.equal(diagnostic?.kind, CODEX_LINEAR_AUTH_FAILURE_KIND)
})

test("detects Linear connector authentication failures", () => {
  const diagnostic = diagnoseCodexLinearAuthFailure({
    stderr: "Linear connector authentication required; please sign in before using the MCP tool.",
  })

  assert.equal(diagnostic?.kind, CODEX_LINEAR_AUTH_FAILURE_KIND)
})

test("ignores service Linear API key configuration failures", () => {
  const diagnostic = diagnoseCodexLinearAuthFailure({
    error: "未设置 LINEAR_API_KEY。",
  })

  assert.equal(diagnostic, null)
})

test("ignores ordinary Linear network failures without auth signals", () => {
  const diagnostic = diagnoseCodexLinearAuthFailure({
    stderr: "linear.get_issue failed: ECONNRESET while contacting mcp.linear.app",
  })

  assert.equal(diagnostic, null)
})

test("ignores authentication failures from non-Linear tools", () => {
  const diagnostic = diagnoseCodexLinearAuthFailure({
    stderr: "github connector unauthorized, please login again",
  })

  assert.equal(diagnostic, null)
})

test("does not echo sensitive input text in the diagnostic", () => {
  const diagnostic = diagnoseCodexLinearAuthFailure({
    stdout: "mcp__linear.get_issue Unauthorized token expired sk-live-secret-value",
  })

  assert.equal(diagnostic?.kind, CODEX_LINEAR_AUTH_FAILURE_KIND)
  assert.equal(JSON.stringify(diagnostic).includes("sk-live-secret-value"), false)
})

test("identifies failed run metadata marked as Codex Linear auth failure", () => {
  assert.equal(
    isCodexLinearAuthFailureRun({
      status: "failed",
      failureKind: CODEX_LINEAR_AUTH_FAILURE_KIND,
    }),
    true,
  )
  assert.equal(isCodexLinearAuthFailureRun({ status: "failed", error: "Codex 退出码为 1" }), false)
})
