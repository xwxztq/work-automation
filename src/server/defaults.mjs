export const DEFAULT_CONFIG = {
  serverId: "本机",
  host: "127.0.0.1",
  port: 4378,
  pollIntervalSeconds: 60,
  linear: {
    apiKeyEnv: "LINEAR_API_KEY",
  },
  codex: {
    bin: "codex",
    defaultArgs: ["--json", "--skip-git-repo-check"],
    part1Sandbox: "read-only",
    splitSandbox: "read-only",
    part2Sandbox: "danger-full-access",
    part3Sandbox: "danger-full-access",
  },
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
  projects: [],
}

export const STATE_DIR = ".linear-automation"
export const RUNS_DIR = "runs"
export const EVENTS_FILE = "events.jsonl"
export const PROCESSED_FILE = "processed-issues.json"
