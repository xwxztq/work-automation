import test from "node:test"
import assert from "node:assert/strict"

import {
  buildIssueReviewPromptContext,
  buildPromptContext,
  buildRunPromptContext,
  findLatestCommentByMarker,
  formatPromptComments,
} from "./prompts.mjs"

test("buildRunPromptContext exposes absolute and relative part3 paths", () => {
  const context = buildRunPromptContext("/repo/work-automation", {
    id: "run-123",
    dir: "/repo/work-automation/.linear-automation/runs/run-123",
    metadataPath: "/repo/work-automation/.linear-automation/runs/run-123/run.json",
    promptPath: "/repo/work-automation/.linear-automation/runs/run-123/prompt.md",
    stdoutPath: "/repo/work-automation/.linear-automation/runs/run-123/stdout.jsonl",
    stderrPath: "/repo/work-automation/.linear-automation/runs/run-123/stderr.log",
    finalPath: "/repo/work-automation/.linear-automation/runs/run-123/final.txt",
  })

  assert.equal(context.CURRENT_RUN_ID, "run-123")
  assert.equal(
    context.CURRENT_REVIEW_DIR_RELATIVE,
    ".linear-automation/runs/run-123/review",
  )
  assert.match(context.CURRENT_REVIEW_DIR || "", /run-123\/review$/)
})

test("buildIssueReviewPromptContext extracts latest implementation comment and ignores automation followups", () => {
  const comments = [
    {
      id: "comment-1",
      createdAt: "2026-06-25T07:00:00.000Z",
      body: "AI Triage: READY\n\n摘要: ...",
      user: { name: "triage" },
    },
    {
      id: "comment-2",
      createdAt: "2026-06-25T07:05:00.000Z",
      body: "Codex Implementation Complete\n\n提交:\n- abc123",
      user: { name: "codex" },
    },
    {
      id: "comment-3",
      createdAt: "2026-06-25T07:06:00.000Z",
      body: "用户补充：这个改动还需要检查空状态。",
      user: { name: "jack" },
    },
    {
      id: "comment-4",
      createdAt: "2026-06-25T07:07:00.000Z",
      body: "Codex Handoff\n\n已认领并开始实现。",
      user: { name: "codex" },
    },
  ]

  const context = buildIssueReviewPromptContext({ comments })

  assert.match(context.LATEST_IMPLEMENTATION_COMMENT || "", /abc123/)
  assert.match(context.POST_IMPLEMENTATION_USER_COMMENTS || "", /用户补充/)
  assert.doesNotMatch(context.POST_IMPLEMENTATION_USER_COMMENTS || "", /Codex Handoff/)
})

test("findLatestCommentByMarker returns the newest exact marker block", () => {
  const latest = findLatestCommentByMarker(
    [
      { id: "1", body: "Codex Implementation Complete\n\nold" },
      { id: "2", body: "Codex Auto Review Complete\n\nskip" },
      { id: "3", body: "\nCodex Implementation Complete\n\nnew" },
    ],
    "Codex Implementation Complete",
  )

  assert.equal(latest?.id, "3")
})

test("buildPromptContext merges extra stage context", () => {
  const context = buildPromptContext(
    {
      serverId: "本机",
      statuses: {
        todo: "Todo",
        needsClarification: "Needs Clarification",
        blocked: "Blocked",
        ready: "Ready for Codex",
        schedule: "On Schedule",
        inProgress: "In Progress",
        testing: "Testing",
        readyForReview: "Ready for Review",
      },
    },
    {
      key: "demo",
      repoName: "Demo Repo",
      path: "/repo/demo",
      codexCwd: "/repo/demo",
      linearProjectId: "project-1",
      branchOrScopePrefix: "main",
      defaultTests: ["pnpm test"],
      extraRules: "无额外项目规则。",
    },
    {
      CURRENT_RUN_DIR: "/repo/work-automation/.linear-automation/runs/run-123",
    },
  )

  assert.equal(context.CURRENT_RUN_DIR, "/repo/work-automation/.linear-automation/runs/run-123")
  assert.deepEqual(context.DEFAULT_TEST_COMMANDS, ["- pnpm test"])
})

test("formatPromptComments keeps recent comment blocks readable", () => {
  const text = formatPromptComments([
    {
      id: "1",
      createdAt: "2026-06-25T07:00:00.000Z",
      body: "First",
      user: { name: "jack" },
    },
    {
      id: "2",
      createdAt: "2026-06-25T07:01:00.000Z",
      body: "Second",
      user: { name: "codex" },
    },
  ])

  assert.match(text, /2026-06-25T07:00:00.000Z jack/)
  assert.match(text, /Second/)
})
