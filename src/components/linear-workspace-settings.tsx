import { useEffect, useState } from "react"
import { toast } from "sonner"
import { api } from "@/app/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AppConfig, LinearProjectOption, LinearWorkspaceMode } from "@/shared/types"

const MODES = ["isolated", "migrated"] as const

export function WorkspaceSettings({ config, onSaved, busy }: {
  config: AppConfig
  onSaved: (config: AppConfig) => void
  busy: boolean
}) {
  const { workspaces, mappings, activeWorkspaceId } = config.linear
  const [apiKey, setApiKey] = useState("")
  const [mode, setMode] = useState<LinearWorkspaceMode>("isolated")
  const [saving, setSaving] = useState(false)
  const disabled = busy || saving

  async function save(action: () => Promise<AppConfig>) {
    setSaving(true)
    try {
      onSaved(await action())
      toast.success("Linear 工作区设置已保存")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Linear 工作区</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          非激活工作区设为 isolated 时停止监听。设为 migrated 时，按项目映射将新事项复制到当前激活的工作区。
        </p>
        <div className="divide-y rounded-md border px-3">
          {workspaces.map((workspace) => (
            <div className="flex items-center justify-between gap-3 py-2.5" key={workspace.id}>
              <div className="truncate text-sm font-medium">
                {workspace.name}
                {workspace.id === activeWorkspaceId && <span className="ml-2 text-xs text-muted-foreground">当前激活</span>}
              </div>
              <WorkspaceModeSelect label={`${workspace.name}的模式`} value={workspace.mode} disabled={disabled}
                onChange={(next) => void save(() => api.updateLinearWorkspace(workspace.id, { mode: next }))} />
            </div>
          ))}
        </div>
        <form className="flex flex-wrap items-center gap-2" onSubmit={async (event) => {
          event.preventDefault()
          if (await save(() => api.bindLinearWorkspace(apiKey.trim(), mode))) setApiKey("")
        }}>
          <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off" aria-label="新工作区的 Linear API key" placeholder="新工作区的 Linear API key" className="min-w-40 flex-1" />
          <WorkspaceModeSelect label="新工作区的模式" value={mode} disabled={disabled} onChange={setMode} />
          <Button type="submit" disabled={disabled || !apiKey.trim()}>绑定工作区</Button>
        </form>
        {workspaces.length > 1 && (
          <div className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-semibold">项目迁移映射</h3>
            <p className="text-sm text-muted-foreground">多个来源项目可指向同一个 WA 项目。目标工作区激活且目标项目启用时，映射开始接收入队事项。</p>
            {mappings.map((mapping) => (
              <div key={mapping.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span>
                  {workspaces.find((workspace) => workspace.id === mapping.sourceWorkspaceId)?.name} / {mapping.sourceProjectName}
                  {" → "}
                  {workspaces.find((workspace) => workspace.id === mapping.targetWorkspaceId)?.name} / {config.projects.find((project) => project.key === mapping.targetProjectKey)?.repoName} / {mapping.targetTeamName}
                </span>
                <Button variant="outline" size="sm" disabled={disabled}
                  onClick={() => void save(() => api.removeLinearMapping(mapping.id))}>删除映射</Button>
              </div>
            ))}
            <MappingForm config={config} disabled={disabled} save={save} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MappingForm({ config, disabled, save }: {
  config: AppConfig
  disabled: boolean
  save: (action: () => Promise<AppConfig>) => Promise<boolean>
}) {
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState("")
  const [sourceProjectId, setSourceProjectId] = useState("")
  const [targetProjectKey, setTargetProjectKey] = useState("")
  const [targetTeamId, setTargetTeamId] = useState("")
  const sourceProjects = useWorkspaceProjects(sourceWorkspaceId)
  const targets = config.projects.filter((project) => (project.workspaceId || "default") !== sourceWorkspaceId)
  const targetProject = targets.find((project) => project.key === targetProjectKey)
  const targetProjects = useWorkspaceProjects(targetProject ? targetProject.workspaceId || "default" : "")
  const teams = targetProjects.find((project) => project.id === targetProject?.linearProjectId)?.teams || []
  const teamId = teams.length === 1 ? teams[0].id : targetTeamId

  return (
    <form className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]" onSubmit={async (event) => {
      event.preventDefault()
      if (await save(() => api.addLinearMapping({ sourceWorkspaceId, sourceProjectId, targetProjectKey, targetTeamId: teamId }))) {
        setSourceProjectId("")
      }
    }}>
      <MappingSelect label="来源工作区" value={sourceWorkspaceId} options={config.linear.workspaces} disabled={disabled}
        onChange={(id) => { setSourceWorkspaceId(id); setSourceProjectId(""); setTargetProjectKey(""); setTargetTeamId("") }} />
      <MappingSelect label="来源 Linear 项目" value={sourceProjectId} disabled={disabled || !sourceProjects.length}
        options={sourceProjects.map((project) => ({ id: project.id, name: project.displayName }))} onChange={setSourceProjectId} />
      <MappingSelect label="目标 WA 项目" value={targetProjectKey} disabled={disabled || !sourceWorkspaceId || !targets.length}
        options={targets.map((project) => ({ id: project.key, name: `${project.repoName} · ${config.linear.workspaces.find((workspace) => workspace.id === (project.workspaceId || "default"))?.name}` }))}
        onChange={(key) => { setTargetProjectKey(key); setTargetTeamId("") }} />
      <MappingSelect label="目标 Linear 团队" value={teamId} options={teams} disabled={disabled || teams.length <= 1} onChange={setTargetTeamId} />
      <Button type="submit" disabled={disabled || !sourceWorkspaceId || !sourceProjectId || !targetProject || !teams.some((team) => team.id === teamId)}>
        添加映射
      </Button>
      {sourceWorkspaceId && !targets.length && (
        <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-5">请先切换到目标工作区并配置一个 WA 项目。</p>
      )}
    </form>
  )
}

function useWorkspaceProjects(workspaceId: string) {
  const [catalog, setCatalog] = useState<{ workspaceId: string; projects: LinearProjectOption[] }>()
  useEffect(() => {
    if (!workspaceId) return
    let active = true
    void api.listLinearProjects(workspaceId).then(({ projects }) => {
      if (active) setCatalog({ workspaceId, projects })
    }).catch((error) => {
      if (active) toast.error(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [workspaceId])
  return catalog?.workspaceId === workspaceId ? catalog.projects : []
}

function MappingSelect({ label, value, options, disabled, onChange }: {
  label: string
  value: string
  options: { id: string; name: string }[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={label}><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
    </Select>
  )
}

function WorkspaceModeSelect({ label, value, disabled, onChange }: {
  label: string
  value: LinearWorkspaceMode
  disabled: boolean
  onChange: (mode: LinearWorkspaceMode) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(mode) => onChange(mode as LinearWorkspaceMode)}>
      <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{MODES.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}</SelectContent>
    </Select>
  )
}
