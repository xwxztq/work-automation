export type PromptStage = "part1" | "part2" | "part3"
export type Stage = PromptStage | "both"

export type LinearProjectOption = {
  id: string
  name: string
  displayName: string
  url: string | null
  teamNames: string[]
}

export type ProjectConfig = {
  key: string
  enabled: boolean
  linearProjectId: string
  repoName: string
  path: string
  codexCwd: string
  branchOrScopePrefix: string
  maxActivePart2: number
  defaultTests: string[]
  part1PromptMode: "global" | "override"
  part2PromptMode: "global" | "override"
  part3PromptMode: "global" | "override"
  extraRules: string
}

export type AppConfig = {
  serverId: string
  host: string
  port: number
  pollIntervalSeconds: number
  linear: {
    apiKeyEnv: string
    apiKeySet?: boolean
  }
  codex: {
    bin: string
    defaultArgs: string[]
    part1Sandbox: string
    part2Sandbox: string
    part3Sandbox: string
  }
  statuses: {
    todo: string
    needsClarification: string
    blocked: string
    ready: string
    schedule: string
    inProgress: string
    testing: string
    readyForReview: string
  }
  projects: ProjectConfig[]
}

export type PromptBundle = {
  global: {
    part1: string
    part2: string
    part3: string
  }
  projects: Record<
    string,
    {
      part1: string
      part2: string
      part3: string
      part1IsOverride: boolean
      part2IsOverride: boolean
      part3IsOverride: boolean
    }
  >
}

export type RunSummary = {
  id: string
  projectKey: string
  stage: PromptStage
  issueIdentifier: string
  issueTitle: string
  status: "running" | "succeeded" | "failed" | "canceled"
  createdAt: string
  updatedAt: string
  dir: string
  exitCode?: number
  error?: string
  failureKind?: string
  failureSummary?: string
  failureAction?: string
  retryableFailure?: boolean
  codexStarted?: boolean
  startupError?: string | null
  supervisorPid?: number | null
  codexPid?: number | null
  supervisorStartedAt?: string
  finalJson?: unknown
  pid?: number | null
  canceledAt?: string
  cancelReason?: string
}

export type RunListResponse = {
  runs: RunSummary[]
  totalCount: number
}

export type RunRequestAccepted = {
  accepted: true
  stage: Stage
  projectKey?: string | null
  issueId?: string | null
  force?: boolean | null
  submittedAt: string
}

export type LinearProjectListResponse = {
  projects: LinearProjectOption[]
}

export type RunDetail = RunSummary & {
  stdout: string
  stderr: string
  final: string
  prompt: string
}

export type CodexActivityKind =
  | "booting"
  | "thinking"
  | "command"
  | "tool"
  | "writing"
  | "todo"
  | "searching"
  | "waiting"
  | "done"
  | "failed"
  | "canceled"

export type CodexActivityMotion =
  | "idle"
  | "typing"
  | "reading"
  | "running"
  | "walking"
  | "waiting"
  | "success"
  | "failure"

export type CodexActivityTool =
  | "shell"
  | "git"
  | "test"
  | "linear"
  | "search"
  | "edit"
  | "todo"
  | "other"

export type CodexActivityAgent = {
  runId: string
  projectKey: string
  stage: string
  issueIdentifier: string
  issueTitle: string
  startedAt: string
  status: RunSummary["status"]
  activityKind: CodexActivityKind
  activityMotion: CodexActivityMotion
  activityTool: CodexActivityTool
  activityLabel: string
  detail: string
  updatedAt: string
  pid?: number | null
  supervisorPid?: number | null
  codexPid?: number | null
}

export type CodexActivityPayload = {
  generatedAt: string
  agents: CodexActivityAgent[]
}

export type ExecutionEvent = {
  timestamp: string
  level: "info" | "warn" | "error"
  type: string
  message: string
  projectKey?: string
  stage?: Stage
  issueIdentifier?: string
  runId?: string
  data?: Record<string, unknown>
}

export type DaemonStatus = {
  enabled: boolean
  running: boolean
  nextRunAt: string | null
  lastError?: string | null
  activeRuns: Array<{
    runId: string
    projectKey: string
    stage: string
    startedAt: string
    pid?: number | null
    supervisorPid?: number | null
    codexPid?: number | null
    issue: {
      id?: string
      identifier: string
      title: string
    }
  }>
}
