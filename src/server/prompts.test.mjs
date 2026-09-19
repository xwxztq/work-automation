import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { parseAgentResult } from "./agent-result-protocol.mjs"
import { createAgentResultContext } from "./agent-result-runtime.mjs"
import {
  buildAgentResultPromptSection,
  buildIssueReviewPromptContext,
  buildIssueSnapshot,
  buildPromptContext,
  buildRunPromptContext,
  findLatestCommentByMarker,
  formatPromptComments,
  readPrompt,
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
  assert.equal(context.AUTOMATION_ROOT_DIR, undefined)
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
        tooLarge: "Too Large",
        needsSplitting: "Needs Splitting",
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
  assert.equal(context.STATUS_TOO_LARGE, "Too Large")
  assert.equal(context.STATUS_NEEDS_SPLITTING, "Needs Splitting")
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

test("issue snapshot keeps service context but removes user email fields", () => {
  const snapshot = buildIssueSnapshot({
    id: "issue-1",
    identifier: "LIV-1",
    assignee: { name: "Jack", email: "jack@example.test" },
    comments: [
      {
        id: "comment-1",
        body: "context",
        user: { name: "Xuan", email: "xuan@example.test" },
      },
    ],
  })

  assert.deepEqual(snapshot.assignee, { name: "Jack" })
  assert.deepEqual(snapshot.comments[0].user, { name: "Xuan" })
  assert.doesNotMatch(JSON.stringify(snapshot), /example\.test/u)
})

test("issue snapshot includes normalized relation context for every stage", () => {
  const snapshot = buildIssueSnapshot({
    id: "issue-1",
    identifier: "LIV-1",
    relations: [
      {
        id: "relation-1",
        type: "blocks",
        direction: "incoming",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T01:00:00.000Z",
        issue: {
          id: "issue-2",
          identifier: "LIV-2",
          title: "前置事项",
          url: "https://linear.example/LIV-2",
          target: { platform: "primary-issues", issueId: "issue-2" },
          email: "should-not-leak@example.test",
        },
      },
    ],
  })

  assert.deepEqual(snapshot.relations, [
    {
      id: "relation-1",
      type: "blocks",
      direction: "incoming",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T01:00:00.000Z",
      issue: {
        id: "issue-2",
        identifier: "LIV-2",
        title: "前置事项",
        url: "https://linear.example/LIV-2",
        target: { platform: "primary-issues", issueId: "issue-2" },
      },
    },
  ])
  assert.doesNotMatch(JSON.stringify(snapshot), /should-not-leak/u)
})

test("all stages use the same immutable v2 binding and produce parser-valid no-op results", () => {
  for (const stage of ["part1", "split", "part2", "part3"]) {
    const context = createAgentResultContext({
      stage,
      projectKey: "work-automation",
      issue: {
        id: "issue-1172",
        identifier: "LIV-1172",
        parent: { id: "issue-1170" },
      },
    })
    const section = buildAgentResultPromptSection(context, {
      id: "issue-1172",
      identifier: "LIV-1172",
      title: "Structured result",
    })
    const finalText = JSON.stringify({
      schemaVersion: "2",
      run: {
        stage: context.stage,
        projectKey: context.projectKey,
        parentIssueId: context.parentIssueId,
        allowedOperations: context.allowedOperations,
      },
      target: context.target,
      operations: [],
    })

    assert.match(section, /"schemaVersion": "2"/u)
    assert.match(section, /"platform": "primary-issues"/u)
    assert.match(section, /不得调用 Linear API、Linear MCP、Linear skill/u)
    assert.equal(parseAgentResult(finalText, context).ok, true)
  }
})

test("global prompts request structured operations instead of direct Linear writes", async () => {
  for (const stage of ["part1", "split", "part2", "part3"]) {
    const prompt = await readPrompt(path.resolve(process.cwd()), "global", stage)

    assert.match(prompt, /operations/u)
    assert.match(prompt, /不要调用 Linear API、MCP、skill/u)
    assert.doesNotMatch(prompt, /优先使用可用的 Linear 工具/u)
    assert.doesNotMatch(prompt, /当前进程环境里的 Linear API key/u)
    assert.doesNotMatch(prompt, /当前 Codex agent 负责读取 Linear/u)
    assert.doesNotMatch(prompt, /已移动到 `\{\{STATUS_/u)
  }
})

test("part3 prompt keeps inline evidence and declares controlled comment images", async () => {
  const prompt = await readPrompt(path.resolve(process.cwd()), "global", "part3")

  assert.match(prompt, /不能只给路径/u)
  assert.match(prompt, /comment\.create\.payload\.images/u)
  assert.match(prompt, /不生成 `attachment\.upload`/u)
  assert.match(prompt, /不要伪造链接或声称上传成功/u)
  assert.doesNotMatch(prompt, /Work Automation 根目录/u)
})

test("split prompt queues child creation and forbids fabricated child IDs", async () => {
  const prompt = await readPrompt(path.resolve(process.cwd()), "global", "split")

  assert.match(prompt, /Codex Split Complete/u)
  assert.match(prompt, /覆盖清单/u)
  assert.match(prompt, /issue\.child\.create/u)
  assert.match(prompt, /不要伪造 ID/u)
})

test("part1 prompt keeps too-large status behind manual split approval", async () => {
  const prompt = await readPrompt(path.resolve(process.cwd()), "global", "part1")

  assert.match(prompt, /\{\{STATUS_TOO_LARGE\}\}/u)
  assert.match(prompt, /不要请求继续移动到/u)
})
