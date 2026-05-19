import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleDot,
  FileText,
  FolderGit2,
  Play,
  RefreshCcw,
  Save,
  Server,
  Settings,
  Square,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/app/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Toaster } from "@/components/ui/sonner"
import type {
  AppConfig,
  DaemonStatus,
  ProjectConfig,
  PromptBundle,
  RunDetail,
  RunSummary,
  Stage,
} from "@/shared/types"

type Page = "projects" | "prompts" | "runs" | "settings"

const emptyProject: ProjectConfig = {
  key: "",
  enabled: true,
  linearProjectId: "",
  repoName: "",
  path: "",
  codexCwd: "",
  branchOrScopePrefix: "",
  maxActivePart2: 1,
  defaultTests: [],
  part1PromptMode: "global",
  part2PromptMode: "global",
  extraRules: "无额外项目规则。",
}

function App() {
  const [page, setPage] = useState<Page>("projects")
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [prompts, setPrompts] = useState<PromptBundle | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null)
  const [selectedProjectKey, setSelectedProjectKey] = useState("")
  const [draftProject, setDraftProject] = useState<ProjectConfig>(emptyProject)
  const [promptScope, setPromptScope] = useState("global")
  const [promptStage, setPromptStage] = useState<"part1" | "part2">("part1")
  const [promptText, setPromptText] = useState("")
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null)
  const [manualStage, setManualStage] = useState<Stage>("both")
  const [manualIssue, setManualIssue] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshAll()
    // Initial load only. Manual refresh buttons and mutations refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!config) return
    const project = config.projects.find((item) => item.key === selectedProjectKey)
    setDraftProject(project ? { ...project } : emptyProject)
  }, [config, selectedProjectKey])

  useEffect(() => {
    if (!prompts) return
    if (promptScope === "global") {
      setPromptText(prompts.global[promptStage])
      return
    }
    setPromptText(prompts.projects[promptScope]?.[promptStage] || "")
  }, [prompts, promptScope, promptStage])

  const activeProjectKeys = useMemo(
    () => config?.projects.map((project) => project.key).filter(Boolean) || [],
    [config],
  )

  async function refreshAll() {
    setBusy(true)
    try {
      const [nextConfig, nextPrompts, nextRuns, nextDaemon] = await Promise.all([
        api.getConfig(),
        api.getPrompts(),
        api.getRuns(),
        api.getDaemonStatus(),
      ])
      setConfig(nextConfig)
      setPrompts(nextPrompts)
      setRuns(nextRuns.runs)
      setDaemon(nextDaemon)
      if (!selectedProjectKey && nextConfig.projects[0]) {
        setSelectedProjectKey(nextConfig.projects[0].key)
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveConfig(nextConfig: AppConfig) {
    setBusy(true)
    try {
      const saved = await api.saveConfig(nextConfig)
      setConfig(saved)
      toast.success("配置已保存")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  function updateDraftProject(patch: Partial<ProjectConfig>) {
    setDraftProject((current) => ({ ...current, ...patch }))
  }

  async function saveProject() {
    if (!config) return
    if (!draftProject.key.trim()) {
      toast.error("项目标识不能为空")
      return
    }
    const exists = config.projects.some((project) => project.key === draftProject.key)
    const projects = exists
      ? config.projects.map((project) => (project.key === draftProject.key ? draftProject : project))
      : [...config.projects, draftProject]
    await saveConfig({ ...config, projects })
    setSelectedProjectKey(draftProject.key)
  }

  async function removeProject(key: string) {
    if (!config) return
    const projects = config.projects.filter((project) => project.key !== key)
    await saveConfig({ ...config, projects })
    setSelectedProjectKey(projects[0]?.key || "")
  }

  async function savePrompt() {
    setBusy(true)
    try {
      await api.savePrompt(promptScope, promptStage, promptText)
      setPrompts(await api.getPrompts())
      toast.success("提示词已保存")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function validateConfig() {
    setBusy(true)
    try {
      const result = await api.validateConfig()
      if (result.ok) {
        toast.success("配置校验通过")
      } else {
        toast.error(result.errors.join("\n"))
      }
      if (result.warnings.length) {
        toast.warning(result.warnings.join("\n"))
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function triggerOnce(stage: Stage, issueId?: string) {
    setBusy(true)
    try {
      if (issueId) {
        await api.runIssue(stage, issueId)
      } else {
        await api.runOnce(stage)
      }
      toast.success("执行已完成")
      await refreshRuns()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function refreshRuns() {
    const [nextRuns, nextDaemon] = await Promise.all([api.getRuns(), api.getDaemonStatus()])
    setRuns(nextRuns.runs)
    setDaemon(nextDaemon)
  }

  async function loadRun(id: string) {
    try {
      setSelectedRun(await api.getRun(id))
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  async function toggleDaemon(next: boolean) {
    setBusy(true)
    try {
      setDaemon(next ? await api.startDaemon() : await api.stopDaemon())
      toast.success(next ? "轮询已启动" : "轮询已停止")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (!config || !prompts) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background">
        <Card className="w-[360px]">
          <CardHeader>
            <CardTitle>Linear 自动执行</CardTitle>
          </CardHeader>
        </Card>
        <Toaster />
      </main>
    )
  }

  return (
    <main className="min-h-svh bg-muted/30">
      <div className="grid min-h-svh grid-cols-[240px_1fr]">
        <aside className="border-r bg-sidebar px-3 py-4 text-sidebar-foreground">
          <div className="mb-5 flex items-center gap-2 px-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <Bot className="size-4" />
            </div>
            <div>
              <div className="text-sm font-medium">Linear 自动执行</div>
              <div className="text-xs text-muted-foreground">{config.serverId}</div>
            </div>
          </div>

          <nav className="space-y-1">
            <NavButton page="projects" active={page} setPage={setPage} icon={FolderGit2} label="项目" />
            <NavButton page="prompts" active={page} setPage={setPage} icon={FileText} label="提示词" />
            <NavButton page="runs" active={page} setPage={setPage} icon={Activity} label="运行" />
            <NavButton page="settings" active={page} setPage={setPage} icon={Settings} label="设置" />
          </nav>

          <Separator className="my-4" />

          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Server className="size-4" />
                轮询
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {daemon?.enabled ? "已启动" : "已停止"} · {daemon?.running ? "执行中" : "空闲"}
                </span>
                <Switch
                  checked={Boolean(daemon?.enabled)}
                  disabled={busy}
                  onCheckedChange={(checked) => void toggleDaemon(checked)}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                下次扫描: {daemon?.nextRunAt ? formatDate(daemon.nextRunAt) : "-"}
              </div>
              {daemon?.lastError && (
                <div className="text-xs text-destructive">
                  错误: {daemon.lastError}
                </div>
              )}
            </CardContent>
          </Card>
        </aside>

        <section className="min-w-0 px-5 py-4">
          <header className="mb-4 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold tracking-normal">Codex 执行控制</h1>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void refreshAll()} disabled={busy}>
                <RefreshCcw className="size-4" />
                刷新
              </Button>
              <Button onClick={() => void validateConfig()} disabled={busy}>
                <CheckCircle2 className="size-4" />
                校验
              </Button>
            </div>
          </header>

          {page === "projects" && (
            <ProjectsPage
              config={config}
              draftProject={draftProject}
              selectedProjectKey={selectedProjectKey}
              setSelectedProjectKey={setSelectedProjectKey}
              updateDraftProject={updateDraftProject}
              saveProject={() => void saveProject()}
              removeProject={(key) => void removeProject(key)}
              addProject={() => {
                const key = `project-${config.projects.length + 1}`
                setSelectedProjectKey(key)
                setDraftProject({ ...emptyProject, key, repoName: key, branchOrScopePrefix: key })
              }}
            />
          )}

          {page === "prompts" && (
            <PromptsPage
              projectKeys={activeProjectKeys}
              promptScope={promptScope}
              promptStage={promptStage}
              promptText={promptText}
              setPromptScope={setPromptScope}
              setPromptStage={setPromptStage}
              setPromptText={setPromptText}
              savePrompt={() => void savePrompt()}
            />
          )}

          {page === "runs" && (
            <RunsPage
              runs={runs}
              selectedRun={selectedRun}
              manualStage={manualStage}
              manualIssue={manualIssue}
              setManualStage={setManualStage}
              setManualIssue={setManualIssue}
              refreshRuns={() => void refreshRuns()}
              loadRun={(id) => void loadRun(id)}
              triggerOnce={(stage, issueId) => void triggerOnce(stage, issueId)}
              busy={busy}
            />
          )}

          {page === "settings" && (
            <SettingsPage
              config={config}
              setConfig={setConfig}
              saveConfig={() => void saveConfig(config)}
              busy={busy}
            />
          )}
        </section>
      </div>
      <Toaster />
    </main>
  )
}

function NavButton({
  page,
  active,
  setPage,
  icon: Icon,
  label,
}: {
  page: Page
  active: Page
  setPage: (page: Page) => void
  icon: LucideIcon
  label: string
}) {
  return (
    <Button
      variant={active === page ? "secondary" : "ghost"}
      className="w-full justify-start"
      onClick={() => setPage(page)}
    >
      <Icon className="size-4" />
      {label}
    </Button>
  )
}

function ProjectsPage({
  config,
  draftProject,
  selectedProjectKey,
  setSelectedProjectKey,
  updateDraftProject,
  saveProject,
  removeProject,
  addProject,
}: {
  config: AppConfig
  draftProject: ProjectConfig
  selectedProjectKey: string
  setSelectedProjectKey: (key: string) => void
  updateDraftProject: (patch: Partial<ProjectConfig>) => void
  saveProject: () => void
  removeProject: (key: string) => void
  addProject: () => void
}) {
  return (
    <div className="grid grid-cols-[minmax(360px,480px)_1fr] gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>项目</CardTitle>
            </div>
            <Button onClick={addProject} size="sm">
              <FolderGit2 className="size-4" />
              添加
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标识</TableHead>
                <TableHead>仓库</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {config.projects.map((project) => (
                <TableRow
                  key={project.key}
                  className="cursor-pointer"
                  onClick={() => setSelectedProjectKey(project.key)}
                >
                  <TableCell className="font-mono text-xs">{project.key}</TableCell>
                  <TableCell>{project.repoName}</TableCell>
                  <TableCell>
                    <Badge variant={project.enabled ? "default" : "secondary"}>
                      {project.enabled ? "启用" : "停用"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {config.projects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    尚未配置项目
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{selectedProjectKey ? "项目配置" : "新项目"}</CardTitle>
            </div>
            <div className="flex gap-2">
              {selectedProjectKey && (
                <Button variant="destructive" size="sm" onClick={() => removeProject(selectedProjectKey)}>
                  <Trash2 className="size-4" />
                  删除
                </Button>
              )}
              <Button size="sm" onClick={saveProject}>
                <Save className="size-4" />
                保存
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Field label="项目标识">
            <Input value={draftProject.key} onChange={(event) => updateDraftProject({ key: event.target.value })} />
          </Field>
          <Field label="仓库名称">
            <Input
              value={draftProject.repoName}
              onChange={(event) => updateDraftProject({ repoName: event.target.value })}
            />
          </Field>
          <Field label="Linear 项目 ID">
            <Input
              value={draftProject.linearProjectId}
              onChange={(event) => updateDraftProject({ linearProjectId: event.target.value })}
            />
          </Field>
          <Field label="分支 / 提交范围前缀">
            <Input
              value={draftProject.branchOrScopePrefix}
              onChange={(event) => updateDraftProject({ branchOrScopePrefix: event.target.value })}
            />
          </Field>
          <Field label="仓库路径">
            <Input value={draftProject.path} onChange={(event) => updateDraftProject({ path: event.target.value })} />
          </Field>
          <Field label="Codex 执行路径">
            <Input
              value={draftProject.codexCwd}
              onChange={(event) => updateDraftProject({ codexCwd: event.target.value })}
            />
          </Field>
          <Field label="阶段二并发上限">
            <Input
              type="number"
              value={draftProject.maxActivePart2}
              onChange={(event) => updateDraftProject({ maxActivePart2: Number(event.target.value) })}
            />
          </Field>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <Label>启用</Label>
            <Switch
              checked={draftProject.enabled}
              onCheckedChange={(checked) => updateDraftProject({ enabled: checked })}
            />
          </div>
          <Field label="阶段一提示词模式">
            <ModeSelect
              value={draftProject.part1PromptMode}
              onValueChange={(value) => updateDraftProject({ part1PromptMode: value })}
            />
          </Field>
          <Field label="阶段二提示词模式">
            <ModeSelect
              value={draftProject.part2PromptMode}
              onValueChange={(value) => updateDraftProject({ part2PromptMode: value })}
            />
          </Field>
          <Field label="默认测试命令" className="col-span-2">
            <Textarea
              className="min-h-24 font-mono text-xs"
              value={draftProject.defaultTests.join("\n")}
              onChange={(event) =>
                updateDraftProject({
                  defaultTests: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="项目规则" className="col-span-2">
            <Textarea
              className="min-h-24"
              value={draftProject.extraRules}
              onChange={(event) => updateDraftProject({ extraRules: event.target.value })}
            />
          </Field>
        </CardContent>
      </Card>
    </div>
  )
}

function ModeSelect({
  value,
  onValueChange,
}: {
  value: "global" | "override"
  onValueChange: (value: "global" | "override") => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as "global" | "override")}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="global">全局</SelectItem>
        <SelectItem value="override">覆盖</SelectItem>
      </SelectContent>
    </Select>
  )
}

function PromptsPage({
  projectKeys,
  promptScope,
  promptStage,
  promptText,
  setPromptScope,
  setPromptStage,
  setPromptText,
  savePrompt,
}: {
  projectKeys: string[]
  promptScope: string
  promptStage: "part1" | "part2"
  promptText: string
  setPromptScope: (scope: string) => void
  setPromptStage: (stage: "part1" | "part2") => void
  setPromptText: (text: string) => void
  savePrompt: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>提示词</CardTitle>
          </div>
          <Button onClick={savePrompt}>
            <Save className="size-4" />
            保存
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Tabs value={promptStage} onValueChange={(value) => setPromptStage(value as "part1" | "part2")}>
            <TabsList>
              <TabsTrigger value="part1">阶段一</TabsTrigger>
              <TabsTrigger value="part2">阶段二</TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={promptScope} onValueChange={setPromptScope}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">全局</SelectItem>
              {projectKeys.map((key) => (
                <SelectItem key={key} value={key}>
                  {key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Textarea
          className="min-h-[560px] resize-y font-mono text-xs leading-relaxed"
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
        />
      </CardContent>
    </Card>
  )
}

function RunsPage({
  runs,
  selectedRun,
  manualStage,
  manualIssue,
  setManualStage,
  setManualIssue,
  refreshRuns,
  loadRun,
  triggerOnce,
  busy,
}: {
  runs: RunSummary[]
  selectedRun: RunDetail | null
  manualStage: Stage
  manualIssue: string
  setManualStage: (stage: Stage) => void
  setManualIssue: (issue: string) => void
  refreshRuns: () => void
  loadRun: (id: string) => void
  triggerOnce: (stage: Stage, issueId?: string) => void
  busy: boolean
}) {
  return (
    <div className="grid grid-cols-[minmax(500px,0.9fr)_1.1fr] gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>运行记录</CardTitle>
            </div>
            <Button variant="outline" onClick={refreshRuns} disabled={busy}>
              <RefreshCcw className="size-4" />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-[160px_1fr_auto] gap-2">
            <Select value={manualStage} onValueChange={(value) => setManualStage(value as Stage)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="both">全部</SelectItem>
                <SelectItem value="part1">阶段一</SelectItem>
                <SelectItem value="part2">阶段二</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="可选 issue ID，例如 LIV-123"
              value={manualIssue}
              onChange={(event) => setManualIssue(event.target.value)}
            />
            <Button onClick={() => triggerOnce(manualStage, manualIssue.trim() || undefined)} disabled={busy}>
              <Play className="size-4" />
              执行
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>事项</TableHead>
                <TableHead>阶段</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id} className="cursor-pointer" onClick={() => loadRun(run.id)}>
                  <TableCell>
                    <div className="font-mono text-xs">{run.issueIdentifier}</div>
                    <div className="max-w-[260px] truncate text-xs text-muted-foreground">{run.issueTitle}</div>
                  </TableCell>
                  <TableCell>{stageLabel(run.stage)}</TableCell>
                  <TableCell>
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="text-xs">{formatDate(run.updatedAt)}</TableCell>
                </TableRow>
              ))}
              {runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    暂无运行记录
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>运行详情</CardTitle>
        </CardHeader>
        <CardContent>
          {selectedRun ? (
            <Tabs defaultValue="final">
              <TabsList>
                <TabsTrigger value="final">最终结果</TabsTrigger>
                <TabsTrigger value="stdout">标准输出</TabsTrigger>
                <TabsTrigger value="stderr">错误输出</TabsTrigger>
                <TabsTrigger value="prompt">提示词</TabsTrigger>
              </TabsList>
              <RunLog value="final" text={selectedRun.final || JSON.stringify(selectedRun.finalJson, null, 2) || ""} />
              <RunLog value="stdout" text={selectedRun.stdout} />
              <RunLog value="stderr" text={selectedRun.stderr} />
              <RunLog value="prompt" text={selectedRun.prompt} />
            </Tabs>
          ) : (
            <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
              <CircleDot className="mr-2 size-4" />
              未选择运行记录
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RunLog({ value, text }: { value: string; text: string }) {
  return (
    <TabsContent value={value} className="mt-3">
      <ScrollArea className="h-[560px] rounded-lg border bg-background p-3">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text || "（空）"}</pre>
      </ScrollArea>
    </TabsContent>
  )
}

function SettingsPage({
  config,
  setConfig,
  saveConfig,
  busy,
}: {
  config: AppConfig
  setConfig: (config: AppConfig) => void
  saveConfig: () => void
  busy: boolean
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>服务</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="服务 ID">
            <Input value={config.serverId} onChange={(event) => setConfig({ ...config, serverId: event.target.value })} />
          </Field>
          <Field label="监听地址">
            <Input value={config.host} onChange={(event) => setConfig({ ...config, host: event.target.value })} />
          </Field>
          <Field label="端口">
            <Input
              type="number"
              value={config.port}
              onChange={(event) => setConfig({ ...config, port: Number(event.target.value) })}
            />
          </Field>
          <Field label="轮询间隔秒数">
            <Input
              type="number"
              value={config.pollIntervalSeconds}
              onChange={(event) => setConfig({ ...config, pollIntervalSeconds: Number(event.target.value) })}
            />
          </Field>
          <Button onClick={saveConfig} disabled={busy}>
            <Save className="size-4" />
            保存
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Linear 与 Codex</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Linear API 密钥环境变量">
            <Input
              value={config.linear.apiKeyEnv}
              onChange={(event) =>
                setConfig({ ...config, linear: { ...config.linear, apiKeyEnv: event.target.value } })
              }
            />
          </Field>
          <Field label="Codex 命令">
            <Input
              value={config.codex.bin}
              onChange={(event) => setConfig({ ...config, codex: { ...config.codex, bin: event.target.value } })}
            />
          </Field>
          <Field label="Codex 默认参数">
            <Textarea
              className="min-h-24 font-mono text-xs"
              value={config.codex.defaultArgs.join("\n")}
              onChange={(event) =>
                setConfig({
                  ...config,
                  codex: {
                    ...config.codex,
                    defaultArgs: event.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="阶段一沙箱">
              <Input
                value={config.codex.part1Sandbox}
                onChange={(event) =>
                  setConfig({ ...config, codex: { ...config.codex, part1Sandbox: event.target.value } })
                }
              />
            </Field>
            <Field label="阶段二沙箱">
              <Input
                value={config.codex.part2Sandbox}
                onChange={(event) =>
                  setConfig({ ...config, codex: { ...config.codex, part2Sandbox: event.target.value } })
                }
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card className="col-span-2">
        <CardHeader>
          <CardTitle>Linear 状态</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-4 gap-3">
          {(Object.entries(config.statuses) as Array<[keyof AppConfig["statuses"], string]>).map(([key, value]) => (
            <Field key={key} label={statusConfigLabel(key)}>
              <Input
                value={value}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    statuses: { ...config.statuses, [key]: event.target.value },
                  })
                }
              />
            </Field>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === "succeeded") {
    return (
      <Badge>
        <CheckCircle2 className="size-3" />
        成功
      </Badge>
    )
  }
  if (status === "running") {
    return (
      <Badge variant="secondary">
        <Play className="size-3" />
        运行中
      </Badge>
    )
  }
  return (
    <Badge variant="destructive">
      <Square className="size-3" />
      失败
    </Badge>
  )
}

function stageLabel(stage: string) {
  if (stage === "part1") return "阶段一"
  if (stage === "part2") return "阶段二"
  if (stage === "both") return "全部"
  return stage
}

function statusConfigLabel(key: keyof AppConfig["statuses"]) {
  const labels: Record<keyof AppConfig["statuses"], string> = {
    todo: "待处理",
    needsClarification: "需要澄清",
    blocked: "阻塞",
    ready: "可交给 Codex",
    schedule: "已排期",
    inProgress: "处理中",
    testing: "测试",
  }
  return labels[key]
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default App
