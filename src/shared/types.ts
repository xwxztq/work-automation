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
  status: "running" | "succeeded" | "failed"
  createdAt: string
  updatedAt: string
  dir: string
  exitCode?: number
  error?: string
  finalJson?: unknown
}

export type RunDetail = RunSummary & {
  stdout: string
  stderr: string
  final: string
  prompt: string
}

export type DaemonStatus = {
  enabled: boolean
  running: boolean
  nextRunAt: string | null
  lastError?: string | null
  activeRuns: Array<{
    stage: string
    startedAt: string
    issue: {
      identifier: string
      title: string
    }
  }>
}
