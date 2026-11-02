export const SUPERPOWER_INPUT_STATUS_KEYS = [
  "todo", "needsClarification", "tooLarge", "needsSplitting",
  "blocked", "ready", "schedule", "testing",
]

export const SUPERPOWER_REQUIRED_STATUS_KEYS = [
  "todo", "needsClarification", "blocked", "inProgress", "testing", "readyForReview",
]

export function resolveExecutionStage(config, stage = "both") {
  if (!["both", "part1", "split", "part2", "part3", "superpower"].includes(stage)) {
    throw new Error(`Invalid execution stage: ${stage}`)
  }
  return config.executionMode === "superpower" ? "superpower" : stage
}

export function superpowerEligibleStatuses(config) {
  return new Set(SUPERPOWER_INPUT_STATUS_KEYS.map((key) => config.statuses[key]).filter(Boolean))
}
