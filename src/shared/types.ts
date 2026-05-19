export type Stage = "part1" | "part2" | "both"

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
  }
  statuses: {
    todo: string
    needsClarification: string
    blocked: string
    ready: string
    schedule: string
    inProgress: string
    testing: string
  }
  projects: ProjectConfig[]
}

export type PromptBundle = {
  global: {
    part1: string
    part2: string
  }
  projects: Record<
    string,
    {
      part1: string
      part2: string
      part1IsOverride: boolean
      part2IsOverride: boolean
    }
  >
}

export type RunSummary = {
  id: string
  projectKey: string
  stage: "part1" | "part2"
  issueIdentifier: string
  issueTitle: string
  status: "running" | "succeeded" | "failed" | "canceled"
  createdAt: string
  updatedAt: string
  dir: string
  exitCode?: number
  error?: string
  finalJson?: unknown
  pid?: number | null
  canceledAt?: string
  cancelReason?: string
}

export type RunDetail = RunSummary & {
  stdout: string
  stderr: string
  final: string
  prompt: string
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
    issue: {
      id?: string
      identifier: string
      title: string
    }
  }>
}
