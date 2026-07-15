import assert from "node:assert/strict"
import test from "node:test"

import { buildCodexArgs } from "./codex-runner.mjs"

function fixture(overrides = {}) {
  return {
    config: {
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      codex: {
        defaultArgs: ["--json"],
        part1Sandbox: "danger-full-access",
        splitSandbox: "read-only",
        part2Sandbox: "workspace-write",
        part3Sandbox: "danger-full-access",
      },
      ...overrides.config,
    },
    project: { path: "/repo", codexCwd: "/repo" },
    stage: "part1",
    run: { finalPath: "/run/final.txt" },
    ...overrides,
  }
}

test("Codex receives the configured Linear API key env name as MCP bearer auth", () => {
  const args = buildCodexArgs(fixture())

  assert.deepEqual(args.slice(0, 5), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--config",
    'mcp_servers.linear.bearer_token_env_var="LINEAR_API_KEY"',
  ])
  assert.deepEqual(args.slice(5, 7), ["--sandbox", "danger-full-access"])
})

test("Codex uses a custom Linear API key environment variable", () => {
  const input = fixture()
  input.config.linear.apiKeyEnv = "WORK_LINEAR_TOKEN"

  assert.ok(
    buildCodexArgs(input).includes(
      'mcp_servers.linear.bearer_token_env_var="WORK_LINEAR_TOKEN"',
    ),
  )
})
