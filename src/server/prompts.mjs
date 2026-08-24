import fs from "node:fs/promises"
import path from "node:path"
import { AGENT_RESULT_SCHEMA_VERSION } from "./agent-result-protocol.mjs"
import { ensureDir, fileExists } from "./config.mjs"

const STAGES = new Set(["part1", "split", "part2", "part3"])
const IMPLEMENTATION_COMPLETE_MARKER = "Codex Implementation Complete"

export function promptPath(rootDir, scope, stage) {
  if (!STAGES.has(stage)) {
    throw new Error(`Invalid prompt stage: ${stage}`)
  }
  if (scope === "global") {
    return path.join(rootDir, "prompts", `${stage}.global.md`)
  }
  return path.join(rootDir, "prompts", "projects", `${scope}.${stage}.md`)
}

export async function readPrompt(rootDir, scope, stage) {
  const filePath = promptPath(rootDir, scope, stage)
  if (!(await fileExists(filePath)) && scope !== "global") {
    return readPrompt(rootDir, "global", stage)
  }
  return fs.readFile(filePath, "utf8")
}

export async function writePrompt(rootDir, scope, stage, content) {
  const filePath = promptPath(rootDir, scope, stage)
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`)
  return { filePath }
}

export async function readAllPrompts(rootDir, projects) {
  const global = {
    part1: await readPrompt(rootDir, "global", "part1"),
    split: await readPrompt(rootDir, "global", "split"),
    part2: await readPrompt(rootDir, "global", "part2"),
    part3: await readPrompt(rootDir, "global", "part3"),
  }
  const projectPrompts = {}
  for (const project of projects) {
    projectPrompts[project.key] = {
      part1: await readPrompt(rootDir, project.key, "part1"),
      split: await readPrompt(rootDir, project.key, "split"),
      part2: await readPrompt(rootDir, project.key, "part2"),
      part3: await readPrompt(rootDir, project.key, "part3"),
      part1IsOverride: await fileExists(promptPath(rootDir, project.key, "part1")),
      splitIsOverride: await fileExists(promptPath(rootDir, project.key, "split")),
      part2IsOverride: await fileExists(promptPath(rootDir, project.key, "part2")),
      part3IsOverride: await fileExists(promptPath(rootDir, project.key, "part3")),
    }
  }
  return { global, projects: projectPrompts }
}

export function renderPrompt(template, context) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = context[key]
    if (Array.isArray(value)) {
      return value.join("\n")
    }
    return value == null ? "" : String(value)
  })
}

export function buildPromptContext(config, project, extraContext = {}) {
  const statuses = config.statuses
  return {
    SERVER_ID: config.serverId,
    PROJECT_KEY: project.key,
    REPO_NAME: project.repoName,
    CODEX_CWD: project.codexCwd || project.path,
    LINEAR_PROJECT_ID: project.linearProjectId,
    BRANCH_OR_SCOPE_PREFIX: project.branchOrScopePrefix || project.key,
    DEFAULT_TEST_COMMANDS: (project.defaultTests || []).map((command) => `- ${command}`),
    EXTRA_RULES: project.extraRules || "No extra project-specific rules.",
    STATUS_TODO: statuses.todo,
    STATUS_NEEDS_CLARIFICATION: statuses.needsClarification,
    STATUS_TOO_LARGE: statuses.tooLarge,
    STATUS_NEEDS_SPLITTING: statuses.needsSplitting,
    STATUS_BLOCKED: statuses.blocked,
    STATUS_READY: statuses.ready,
    STATUS_SCHEDULE: statuses.schedule,
    STATUS_IN_PROGRESS: statuses.inProgress,
    STATUS_TESTING: statuses.testing,
    STATUS_READY_FOR_REVIEW: statuses.readyForReview,
    ...extraContext,
  }
}

export function buildRunPromptContext(rootDir, run) {
  if (!run?.dir) {
    return {}
  }
  const reviewDir = path.join(run.dir, "review")
  return {
    AUTOMATION_ROOT_DIR: rootDir,
    CURRENT_RUN_ID: run.id,
    CURRENT_RUN_DIR: run.dir,
    CURRENT_RUN_DIR_RELATIVE: toPortableRelativePath(rootDir, run.dir),
    CURRENT_REVIEW_DIR: reviewDir,
    CURRENT_REVIEW_DIR_RELATIVE: toPortableRelativePath(rootDir, reviewDir),
    CURRENT_RUN_JSON_PATH: run.metadataPath || path.join(run.dir, "run.json"),
    CURRENT_PROMPT_PATH: run.promptPath || path.join(run.dir, "prompt.md"),
    CURRENT_STDOUT_PATH: run.stdoutPath || path.join(run.dir, "stdout.jsonl"),
    CURRENT_STDERR_PATH: run.stderrPath || path.join(run.dir, "stderr.log"),
    CURRENT_FINAL_PATH: run.finalPath || path.join(run.dir, "final.txt"),
  }
}

export function buildIssueReviewPromptContext(issue) {
  const comments = Array.isArray(issue?.comments) ? issue.comments : []
  const latestImplementationComment = findLatestCommentByMarker(
    comments,
    IMPLEMENTATION_COMPLETE_MARKER,
  )
  const latestImplementationIndex = latestImplementationComment
    ? comments.findIndex((comment) => comment.id === latestImplementationComment.id)
    : -1
  const userCommentsAfterImplementation =
    latestImplementationIndex >= 0
      ? comments
          .slice(latestImplementationIndex + 1)
          .filter((comment) => !matchesAutomationComment(comment))
      : []

  return {
    LATEST_IMPLEMENTATION_COMMENT: latestImplementationComment
      ? formatPromptComment(latestImplementationComment)
      : "（无）",
    POST_IMPLEMENTATION_USER_COMMENTS: userCommentsAfterImplementation.length
      ? userCommentsAfterImplementation.map((comment) => formatPromptComment(comment)).join("\n")
      : "（无）",
  }
}

export function buildAgentResultPromptSection(context, issue) {
  const binding = {
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    run: {
      stage: context?.stage,
      projectKey: context?.projectKey,
      parentIssueId: context?.parentIssueId ?? null,
      allowedOperations: context?.allowedOperations,
    },
    target: context?.target,
  }
  return `服务提供的不可变运行上下文:
- 以下边界对全局模板和项目覆盖模板都生效；如有冲突，以这里为准。
- 不得调用 Linear API、Linear MCP、Linear skill 或其他事项平台工具，也不要读取相关凭据。
- 事项信息只使用下方服务快照。需要平台变更时，把意图写入 operations，由服务后续处理。
- 最终输出必须是单个 JSON 文档，不得带 Markdown 代码块或说明文字。
- 最终 JSON 必须原样复制 binding 中的 schemaVersion、run 和 target；run.allowedOperations 也必须保持原顺序与完整内容。
- operations 只能使用 run.allowedOperations 中的类型；每项使用 8 至 128 字符且在本结果内唯一的 idempotencyKey。
- 每项 operation 只包含 type、idempotencyKey 和 payload。comment.create 的 payload 必须包含 body，issue.state.update 必须包含 state，issue.child.create 必须包含 title 和 description，attachment.upload 必须包含 filePath 和 title。
- 不需要平台操作时输出空 operations 数组。不要声称操作已经在平台执行。

运行绑定 binding:
${JSON.stringify(binding, null, 2)}

服务提供的事项快照:
${JSON.stringify(buildIssueSnapshot(issue), null, 2)}`
}

export function buildIssueSnapshot(issue) {
  return {
    id: issue?.id || null,
    identifier: issue?.identifier || null,
    title: issue?.title || "",
    description: issue?.description || "",
    url: issue?.url || null,
    priority: issue?.priority ?? null,
    priorityLabel: issue?.priorityLabel || null,
    createdAt: issue?.createdAt || null,
    updatedAt: issue?.updatedAt || null,
    state: selectFields(issue?.state, ["id", "name", "type"]),
    team: selectFields(issue?.team, ["id", "key", "name"]),
    project: selectFields(issue?.project, ["id", "name"]),
    parent: selectFields(issue?.parent, ["id", "identifier"]),
    assignee: selectFields(issue?.assignee, ["name"]),
    labels: Array.isArray(issue?.labels)
      ? issue.labels.map((label) => selectFields(label, ["id", "name"]))
      : [],
    comments: Array.isArray(issue?.comments)
      ? issue.comments.map((comment) => ({
          id: comment?.id || null,
          body: comment?.body || "",
          createdAt: comment?.createdAt || null,
          updatedAt: comment?.updatedAt || null,
          user: selectFields(comment?.user, ["name"]),
        }))
      : [],
    attachments: Array.isArray(issue?.attachments)
      ? issue.attachments.map((attachment) =>
          selectFields(attachment, ["id", "title", "url"]),
        )
      : [],
  }
}

export function formatPromptComments(comments = [], limit = 20) {
  return comments
    .slice(-Math.max(1, Number(limit || 20)))
    .map((comment) => formatPromptComment(comment))
    .join("\n")
}

export function findLatestCommentByMarker(comments = [], marker) {
  const normalizedMarker = String(marker || "").trim()
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (matchesCommentMarker(comments[index], normalizedMarker)) {
      return comments[index]
    }
  }
  return null
}

export function formatPromptComment(comment) {
  return `---\n${comment?.createdAt || "未知时间"} ${comment?.user?.name || "未知用户"}:\n${comment?.body || ""}`
}

export function extractJson(text) {
  const trimmed = String(text || "").trim()
  if (!trimmed) {
    return null
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim())
      } catch {
        return null
      }
    }
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function matchesCommentMarker(comment, marker) {
  return firstNonEmptyLine(comment?.body) === marker
}

function matchesAutomationComment(comment) {
  const firstLine = firstNonEmptyLine(comment?.body)
  return firstLine.startsWith("AI Triage:") || firstLine.startsWith("Codex ")
}

function firstNonEmptyLine(text) {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || ""
}

function selectFields(value, fields) {
  if (!value || typeof value !== "object") {
    return null
  }
  return Object.fromEntries(
    fields.map((field) => [field, value[field] ?? null]),
  )
}

function toPortableRelativePath(fromDir, targetPath) {
  const relative = path.relative(fromDir, targetPath)
  return relative ? relative.split(path.sep).join("/") : "."
}
