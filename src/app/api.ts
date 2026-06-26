import type {
  AppConfig,
  CodexActivityPayload,
  ConfigValidationResult,
  DaemonStatus,
  ExecutionEvent,
  LinearProjectListResponse,
  LinearStatusHealthResult,
  PromptStage,
  PromptBundle,
  RunDetail,
  RunListResponse,
  RunRequestAccepted,
  Stage,
} from "@/shared/types"

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`)
  }
  return payload as T
}

export const api = {
  getConfig: () => request<AppConfig>("/api/config"),
  saveConfig: (config: AppConfig) =>
    request<AppConfig>("/api/config", { method: "PUT", body: JSON.stringify(config) }),
  validateConfig: () =>
    request<ConfigValidationResult>("/api/config/validate", {
      method: "POST",
    }),
  getLinearStatusHealth: () => request<LinearStatusHealthResult>("/api/linear/status-health"),
  getPrompts: () => request<PromptBundle>("/api/prompts"),
  savePrompt: (scope: string, stage: PromptStage, content: string) =>
    request<{ filePath: string }>(`/api/prompts/${scope}/${stage}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  getRuns: (projectKey?: string) => {
    const search = new URLSearchParams()
    if (projectKey) {
      search.set("projectKey", projectKey)
    }
    const suffix = search.toString() ? `?${search.toString()}` : ""
    return request<RunListResponse>(`/api/runs${suffix}`)
  },
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  getEvents: (limit = 200, projectKey?: string) => {
    const search = new URLSearchParams({ limit: String(limit) })
    if (projectKey) {
      search.set("projectKey", projectKey)
    }
    return request<{ events: ExecutionEvent[] }>(`/api/events?${search.toString()}`)
  },
  getCodexActivity: (projectKey?: string) => {
    const search = new URLSearchParams()
    if (projectKey) {
      search.set("projectKey", projectKey)
    }
    const suffix = search.toString() ? `?${search.toString()}` : ""
    return request<CodexActivityPayload>(`/api/codex/activity${suffix}`)
  },
  getDaemonStatus: () => request<DaemonStatus>("/api/daemon/status"),
  startDaemon: () => request<DaemonStatus>("/api/daemon/start", { method: "POST" }),
  stopDaemon: () => request<DaemonStatus>("/api/daemon/stop", { method: "POST" }),
  runOnce: (stage: Stage, projectKey?: string, force = false) =>
    request<RunRequestAccepted>("/api/runs/once", {
      method: "POST",
      body: JSON.stringify({ stage, projectKey, force }),
    }),
  runIssue: (stage: Stage, issueId: string, projectKey?: string, force = false) =>
    request<RunRequestAccepted>("/api/runs/issue", {
      method: "POST",
      body: JSON.stringify({ stage, issueId, projectKey, force }),
    }),
  cancelRun: (id: string) => request<unknown>(`/api/runs/${id}/cancel`, { method: "POST" }),
  cancelProject: (key: string) => request<unknown>(`/api/projects/${key}/cancel`, { method: "POST" }),
  listLinearProjects: () => request<LinearProjectListResponse>("/api/linear/projects"),
  previewProject: (key: string) => request<unknown>(`/api/projects/${key}/linear-preview`),
}
