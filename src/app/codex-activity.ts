import type { CodexActivityPayload } from "@/shared/types"

type ActivityView = "project" | "activity" | "logs" | "settings"

export type CodexActivityScope =
  | { kind: "project"; projectKey: string }
  | { kind: "global" }

export function getCodexActivityScope(view: ActivityView, projectKey: string): CodexActivityScope | null {
  if (view === "activity") {
    return { kind: "global" }
  }
  if (view === "project" && projectKey) {
    return { kind: "project", projectKey }
  }
  return null
}

export function createCodexActivityLoader(
  requestActivity: (projectKey?: string) => Promise<CodexActivityPayload>,
  fallback: () => CodexActivityPayload,
) {
  const inFlight = new Map<string, Promise<CodexActivityPayload>>()

  return function loadCodexActivity(projectKey?: string) {
    const key = projectKey ? `project:${projectKey}` : "global"
    const existing = inFlight.get(key)
    if (existing) {
      return existing
    }

    const request = Promise.resolve()
      .then(() => requestActivity(projectKey))
      .catch(() => fallback())
      .finally(() => {
        if (inFlight.get(key) === request) {
          inFlight.delete(key)
        }
      })
    inFlight.set(key, request)
    return request
  }
}
