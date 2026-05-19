import type { AppConfig, DaemonStatus, PromptBundle, RunDetail, RunSummary, Stage } from "@/shared/types"

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
    request<{ ok: boolean; errors: string[]; warnings: string[] }>("/api/config/validate", {
      method: "POST",
    }),
  getPrompts: () => request<PromptBundle>("/api/prompts"),
  savePrompt: (scope: string, stage: "part1" | "part2", content: string) =>
    request<{ filePath: string }>(`/api/prompts/${scope}/${stage}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  getRuns: () => request<{ runs: RunSummary[] }>("/api/runs"),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  getDaemonStatus: () => request<DaemonStatus>("/api/daemon/status"),
  startDaemon: () => request<DaemonStatus>("/api/daemon/start", { method: "POST" }),
  stopDaemon: () => request<DaemonStatus>("/api/daemon/stop", { method: "POST" }),
  runOnce: (stage: Stage) =>
    request<unknown>("/api/runs/once", { method: "POST", body: JSON.stringify({ stage }) }),
  runIssue: (stage: Stage, issueId: string) =>
    request<unknown>("/api/runs/issue", {
      method: "POST",
      body: JSON.stringify({ stage, issueId }),
    }),
  previewProject: (key: string) => request<unknown>(`/api/projects/${key}/linear-preview`),
}
