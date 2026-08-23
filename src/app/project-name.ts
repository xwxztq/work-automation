import type { LinearProjectOption, ProjectConfig } from "@/shared/types"

export type ProjectNameSource = "path" | "linear" | "manual"

type ProjectNameSelection = Pick<ProjectConfig, "key" | "repoName">
type LinearProjectSelection = Pick<LinearProjectOption, "id" | "name">
type LinearProjectSelectionUpdate = {
  patch: Pick<ProjectConfig, "linearProjectId"> & Partial<Pick<ProjectConfig, "repoName">>
  source: ProjectNameSource
}

export function getInitialProjectNameSource(editing: boolean): ProjectNameSource {
  return editing ? "manual" : "path"
}

export function getLinearProjectSelectionUpdate(
  project: ProjectNameSelection,
  linearProject: LinearProjectSelection,
  source: ProjectNameSource,
): LinearProjectSelectionUpdate {
  const currentName = project.repoName.trim()
  const linearName = linearProject.name.trim()
  const shouldUseLinearName = Boolean(linearName)
    && (source !== "manual" || !currentName || currentName === project.key)

  return {
    patch: {
      linearProjectId: linearProject.id,
      ...(shouldUseLinearName ? { repoName: linearProject.name } : {}),
    },
    source: shouldUseLinearName ? "linear" : source,
  }
}

export function getProjectNamePatchForPath(
  path: string,
  source: ProjectNameSource,
): Partial<Pick<ProjectConfig, "repoName">> {
  if (source !== "path") return {}
  const repoName = deriveRepoName(path)
  return repoName ? { repoName } : {}
}

export function getProjectNameInputUpdate(nextName: string, path: string) {
  if (!nextName.trim()) {
    return {
      repoName: deriveRepoName(path),
      source: "path" as const,
    }
  }
  return {
    repoName: nextName,
    source: "manual" as const,
  }
}

export function deriveRepoName(path: string) {
  const normalized = path.trim().replace(/[/\\]+$/, "")
  if (!normalized) return ""
  return normalized.split(/[/\\]/).pop() || ""
}
