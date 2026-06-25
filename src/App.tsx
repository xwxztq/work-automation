import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleDot,
  FileJson,
  FolderGit2,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Save,
  ScrollText,
  Settings,
  Square,
  StopCircle,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/app/api"
import { CodexActivityPanel } from "@/components/codex-activity/CodexActivityPanel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
import {
  generateProjectKey,
  getProjectKeySafetyError,
  isSafeProjectKey,
} from "@/shared/project-key"
import { cn } from "@/lib/utils"
import {
  parseCodexStdout,
  type CodexStdoutEvent,
  type CodexStdoutEventKind,
  type CodexStdoutEventStatus,
} from "@/shared/codex-stdout"
import type {
  AppConfig,
  CodexActivityAgent,
  CodexActivityPayload,
  DaemonStatus,
  ExecutionEvent,
  LinearProjectOption,
  PromptStage,
  ProjectConfig,
  PromptBundle,
  RunDetail,
  RunSummary,
  Stage,
} from "@/shared/types"

type View = "project" | "activity" | "logs" | "settings"

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
  part3PromptMode: "global",
  extraRules: "无额外项目规则。",
}

const APP_LOGO_SRC = "/WA-logo.png"
const APP_BRAND_NAME = "Work Automation"
const APP_TITLE_PREFIX = "WA"
const DEFAULT_SERVER_ID = "本机"
const SELECTED_PROJECT_KEY_STORAGE_KEY = "linearAutomation.selectedProjectKey"

const projectFieldDescriptions: Partial<Record<keyof ProjectConfig, string>> = {
  key: "本机配置用的稳定标识，日志和提示词会引用它。",
  repoName: "展示名称，也会写入 Codex 执行提示词。",
  linearProjectId: "Linear 项目 UUID，服务只扫描这个项目下的 issue。",
  branchOrScopePrefix: "用于阶段二提示词和提交 scope，例如 main。",
  path: "本机仓库绝对路径，服务用它定位代码。",
  codexCwd: "codex exec -C 的工作目录；通常等于仓库路径。",
  maxActivePart2: "同一项目同时处于阶段二实现中的 issue 上限，默认 1。",
  defaultTests: "AI Triage 未指定测试时使用，每行一条命令。",
  extraRules: "会写入阶段提示词；只放项目约束，不要放密钥。",
}

const statusConfigDescriptions: Record<keyof AppConfig["statuses"], string> = {
  todo: "阶段一会扫描的新需求入口。",
  needsClarification: "阶段一会复查等待用户补充的问题。",
  blocked: "阶段一会复查阻塞是否解除。",
  ready: "阶段一判断可实现后的等待池，不会自动进入已排期。",
  schedule: "用户人工批准后，阶段二才会认领实现。",
  inProgress: "当前 Codex agent 已认领并正在实现。",
  testing: "阶段二完成后进入阶段三 Auto Review 队列。",
  readyForReview: "阶段三自动复查完成后等待人工验证。",
}

function readPersistedSelectedProjectKey() {
  if (typeof window === "undefined") return ""
  try {
    return window.localStorage.getItem(SELECTED_PROJECT_KEY_STORAGE_KEY) || ""
  } catch {
    return ""
  }
}

function persistSelectedProjectKey(key: string) {
  if (typeof window === "undefined") return
  try {
    if (key) {
      window.localStorage.setItem(SELECTED_PROJECT_KEY_STORAGE_KEY, key)
      return
    }
    window.localStorage.removeItem(SELECTED_PROJECT_KEY_STORAGE_KEY)
  } catch {
    // Browser storage may be unavailable; keep the in-memory selection working.
  }
}

function resolveSelectedProjectKey(projects: ProjectConfig[], preferredKeys: string[]) {
  const availableKeys = new Set(projects.map((project) => project.key).filter(Boolean))
  for (const key of preferredKeys) {
    if (availableKeys.has(key)) {
      return key
    }
  }
  return projects[0]?.key || ""
}

function emptyCodexActivity(): CodexActivityPayload {
  return {
    generatedAt: new Date().toISOString(),
    agents: [],
  }
}

async function loadCodexActivity(projectKey?: string) {
  return api.getCodexActivity(projectKey).catch(() => emptyCodexActivity())
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => (
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  ))

  useEffect(() => {
    const media = window.matchMedia(query)
    const handleChange = () => setMatches(media.matches)

    handleChange()
    media.addEventListener("change", handleChange)
    return () => media.removeEventListener("change", handleChange)
  }, [query])

  return matches
}

function App() {
  const [view, setView] = useState<View>("project")
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [prompts, setPrompts] = useState<PromptBundle | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runTotalCount, setRunTotalCount] = useState(0)
  const [globalRuns, setGlobalRuns] = useState<RunSummary[]>([])
  const [globalRunTotalCount, setGlobalRunTotalCount] = useState(0)
  const [events, setEvents] = useState<ExecutionEvent[]>([])
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null)
  const [codexActivity, setCodexActivity] = useState<CodexActivityPayload>({
    generatedAt: "",
    agents: [],
  })
  const [globalCodexActivity, setGlobalCodexActivity] = useState<CodexActivityPayload>({
    generatedAt: "",
    agents: [],
  })
  const [selectedProjectKey, setSelectedProjectKey] = useState(readPersistedSelectedProjectKey)
  const [draftProject, setDraftProject] = useState<ProjectConfig>(emptyProject)
  const [editingProjectKey, setEditingProjectKey] = useState<string | null>(null)
  const [projectEditorOpen, setProjectEditorOpen] = useState(false)
  const [promptScope, setPromptScope] = useState("global")
  const [promptStage, setPromptStage] = useState<PromptStage>("part1")
  const [promptText, setPromptText] = useState("")
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null)
  const [manualStage, setManualStage] = useState<Stage>("part1")
  const [manualIssue, setManualIssue] = useState("")
  const [manualForce, setManualForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [manualRunSubmitting, setManualRunSubmitting] = useState(false)
  const autoStartTried = useRef(false)

  useEffect(() => {
    void refreshAll()
    // Initial load only. Subsequent updates use explicit refresh and polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      if (view === "activity") {
        void refreshGlobalActivity(true)
        return
      }
      void refreshRuns(true)
    }, 3000)
    return () => clearInterval(timer)
    // Rebind polling when the active view or selected project changes so activity uses the right filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectKey, view])

  useEffect(() => {
    if (view !== "project") {
      return
    }
    if (!selectedProjectKey) {
      setCodexActivity({ generatedAt: "", agents: [] })
      return
    }
    void loadCodexActivity(selectedProjectKey).then(setCodexActivity)
  }, [selectedProjectKey, view])

  useEffect(() => {
    if (view !== "activity") return
    void refreshGlobalActivity(true)
  }, [view])

  useEffect(() => {
    if (!prompts) return
    if (promptScope === "global") {
      setPromptText(prompts.global[promptStage])
      return
    }
    setPromptText(prompts.projects[promptScope]?.[promptStage] || "")
  }, [prompts, promptScope, promptStage])

  useEffect(() => {
    setSelectedRun(null)
  }, [selectedProjectKey, view])

  useEffect(() => {
    if (!daemon || autoStartTried.current) return
    autoStartTried.current = true
    if (!daemon.enabled) {
      void setDaemonEnabled(true, true)
    }
  }, [daemon])

  useEffect(() => {
    const serverName = config?.serverId.trim() || DEFAULT_SERVER_ID
    document.title = `${APP_TITLE_PREFIX} - ${serverName}`
  }, [config?.serverId])

  const selectedProject = useMemo(
    () => config?.projects.find((project) => project.key === selectedProjectKey) || null,
    [config, selectedProjectKey],
  )
  const activeProjectKeys = useMemo(
    () => config?.projects.map((project) => project.key).filter(Boolean) || [],
    [config],
  )
  const projectRuns = useMemo(
    () => runs.filter((run) => run.projectKey === selectedProjectKey),
    [runs, selectedProjectKey],
  )
  const activeProjectRuns = useMemo(
    () => daemon?.activeRuns.filter((run) => run.projectKey === selectedProjectKey) || [],
    [daemon, selectedProjectKey],
  )
  const projectCodexAgents = useMemo(
    () => codexActivity.agents.filter((agent) => agent.projectKey === selectedProjectKey),
    [codexActivity.agents, selectedProjectKey],
  )
  const projectKeyError = useMemo(() => {
    if (!config) return null
    const key = draftProject.key.trim()
    if (!key) {
      return "项目内部标识缺失，请关闭后重新新建项目。"
    }
    const duplicate = config.projects.some((project) => project.key === key && project.key !== editingProjectKey)
    if (duplicate) {
      return `项目内部标识已存在: ${key}`
    }
    if (!isSafeProjectKey(key) && key !== editingProjectKey) {
      return getProjectKeySafetyError(key)
    }
    return null
  }, [config, draftProject.key, editingProjectKey])

  function selectProject(key: string) {
    setSelectedProjectKey(key)
    persistSelectedProjectKey(key)
    setSelectedRun(null)
    setRuns([])
    setRunTotalCount(0)
  }

  function openGlobalActivity() {
    setView("activity")
    setSelectedRun(null)
    void refreshGlobalActivity(true)
  }

  async function refreshCurrentView() {
    if (view === "activity") {
      await refreshGlobalActivity()
      return
    }
    await refreshAll()
  }

  async function refreshAll() {
    setBusy(true)
    try {
      const [nextConfig, nextPrompts, nextDaemon, nextEvents] = await Promise.all([
        api.getConfig(),
        api.getPrompts(),
        api.getDaemonStatus(),
        api.getEvents(),
      ])
      const nextProjectKey = resolveSelectedProjectKey(nextConfig.projects, [
        selectedProjectKey,
        readPersistedSelectedProjectKey(),
      ])
      const [nextRuns, nextCodexActivity] = await Promise.all([
        api.getRuns(nextProjectKey || undefined),
        loadCodexActivity(nextProjectKey || undefined),
      ])
      setConfig(nextConfig)
      setPrompts(nextPrompts)
      setRuns(nextRuns.runs)
      setRunTotalCount(nextRuns.totalCount)
      setDaemon(nextDaemon)
      setEvents(nextEvents.events)
      setCodexActivity(nextCodexActivity)
      setSelectedProjectKey(nextProjectKey)
      persistSelectedProjectKey(nextProjectKey)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveConfig(nextConfig: AppConfig, silent = false) {
    setBusy(true)
    try {
      const saved = await api.saveConfig(nextConfig)
      setConfig(saved)
      if (!silent) {
        toast.success("配置已保存")
      }
      return saved
    } catch (error) {
      toast.error(errorMessage(error))
      return null
    } finally {
      setBusy(false)
    }
  }

  function openNewProject() {
    if (!config) return
    setEditingProjectKey(null)
    setDraftProject({
      ...emptyProject,
      key: generateProjectKey(config.projects.map((project) => project.key)),
      branchOrScopePrefix: "main",
    })
    setProjectEditorOpen(true)
  }

  function openEditProject(project: ProjectConfig) {
    setEditingProjectKey(project.key)
    setDraftProject({ ...project })
    setProjectEditorOpen(true)
  }

  function updateDraftProject(patch: Partial<ProjectConfig>) {
    setDraftProject((current) => ({ ...current, ...patch }))
  }

  async function saveDraftProject() {
    if (!config) return
    const key = draftProject.key.trim()
    if (!key) {
      toast.error("项目内部标识缺失，请关闭后重新新建项目。")
      return
    }
    const duplicate = config.projects.some((project) => project.key === key && project.key !== editingProjectKey)
    if (duplicate) {
      toast.error(`项目内部标识已存在: ${key}`)
      return
    }
    if (!isSafeProjectKey(key) && key !== editingProjectKey) {
      toast.error(getProjectKeySafetyError(key) || "项目内部标识格式不正确")
      return
    }

    const repoPath = draftProject.path.trim()
    const nextProject = {
      ...draftProject,
      key,
      repoName: draftProject.repoName.trim() || key,
      path: repoPath,
      codexCwd: draftProject.codexCwd.trim() || repoPath,
      maxActivePart2: Number(draftProject.maxActivePart2 || 1),
    }
    const projects = editingProjectKey
      ? config.projects.map((project) => (project.key === editingProjectKey ? nextProject : project))
      : [...config.projects, nextProject]
    const saved = await saveConfig({ ...config, projects })
    if (!saved) return
    selectProject(key)
    void refreshRuns(true, key)
    setView("project")
    setProjectEditorOpen(false)
  }

  async function removeProject(key: string) {
    if (!config) return
    const projects = config.projects.filter((project) => project.key !== key)
    const saved = await saveConfig({ ...config, projects })
    if (!saved) return
    const nextProjectKey = resolveSelectedProjectKey(projects, [selectedProjectKey === key ? "" : selectedProjectKey])
    selectProject(nextProjectKey)
    void refreshRuns(true, nextProjectKey)
    setSelectedRun(null)
    setProjectEditorOpen(false)
  }

  async function toggleProjectEnabled(project: ProjectConfig, enabled: boolean) {
    if (!config) return
    const projects = config.projects.map((item) => (item.key === project.key ? { ...item, enabled } : item))
    const saved = await saveConfig({ ...config, projects }, true)
    if (saved) {
      toast.success(enabled ? "项目已启用" : "项目已停用")
    }
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

  async function triggerOnce(stage: Stage, issueId?: string, projectKey?: string, force = false) {
    setManualRunSubmitting(true)
    try {
      if (issueId) {
        await api.runIssue(stage, issueId, projectKey, force)
      } else {
        await api.runOnce(stage, projectKey, force)
      }
      toast.success("执行已提交")
      if (view === "activity") {
        void refreshGlobalActivity(true)
      } else {
        void refreshRuns(true, projectKey || selectedProjectKey)
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setManualRunSubmitting(false)
    }
  }

  function retryRun(run: RunDetail | RunSummary) {
    const issueId = run.issueIdentifier?.trim()
    if (!issueId) {
      toast.error("当前运行记录缺少 issue 标识，无法重试")
      return
    }
    void triggerOnce(run.stage as Stage, issueId, run.projectKey, true)
  }

  async function refreshRuns(silent = false, projectKey = selectedProjectKey) {
    try {
      const [nextRuns, nextDaemon, nextEvents, nextCodexActivity] = await Promise.all([
        api.getRuns(projectKey || undefined),
        api.getDaemonStatus(),
        api.getEvents(),
        loadCodexActivity(projectKey || undefined),
      ])
      setRuns(nextRuns.runs)
      setRunTotalCount(nextRuns.totalCount)
      setDaemon(nextDaemon)
      setEvents(nextEvents.events)
      setCodexActivity(nextCodexActivity)
    } catch (error) {
      if (!silent) {
        toast.error(errorMessage(error))
      }
    }
  }

  async function refreshGlobalActivity(silent = false) {
    try {
      const [nextRuns, nextDaemon, nextEvents, nextCodexActivity] = await Promise.all([
        api.getRuns(),
        api.getDaemonStatus(),
        api.getEvents(),
        loadCodexActivity(),
      ])
      setGlobalRuns(nextRuns.runs)
      setGlobalRunTotalCount(nextRuns.totalCount)
      setDaemon(nextDaemon)
      setEvents(nextEvents.events)
      setGlobalCodexActivity(nextCodexActivity)
    } catch (error) {
      if (!silent) {
        toast.error(errorMessage(error))
      }
    }
  }

  async function loadRun(id: string) {
    try {
      setSelectedRun(await api.getRun(id))
      return true
    } catch (error) {
      toast.error(errorMessage(error))
      return false
    }
  }

  async function setDaemonEnabled(next: boolean, silent = false) {
    setBusy(true)
    try {
      setDaemon(next ? await api.startDaemon() : await api.stopDaemon())
      if (!silent) {
        toast.success(next ? "轮询已启动" : "轮询已停止")
      }
    } catch (error) {
      if (!silent) {
        toast.error(errorMessage(error))
      }
    } finally {
      setBusy(false)
    }
  }

  async function cancelRun(id: string) {
    setBusy(true)
    try {
      await api.cancelRun(id)
      toast.success("任务已停止")
      if (view === "activity") {
        await refreshGlobalActivity(true)
      } else {
        await refreshRuns()
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function cancelProject(key: string) {
    setBusy(true)
    try {
      await api.cancelProject(key)
      toast.success("项目任务已停止")
      await refreshRuns()
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
            <div className="flex items-center gap-3">
              <img src={APP_LOGO_SRC} alt="WorkAutomation logo" className="size-9 rounded-md object-contain" />
              <CardTitle>{APP_BRAND_NAME}</CardTitle>
            </div>
          </CardHeader>
        </Card>
        <Toaster />
      </main>
    )
  }

  return (
    <main className="h-svh overflow-x-hidden bg-muted/30">
      <div className="grid h-full min-h-0 grid-rows-[auto_1fr] md:grid-cols-[280px_1fr] md:grid-rows-none">
        <Sidebar
          config={config}
          daemon={daemon}
          selectedProjectKey={selectedProjectKey}
          view={view}
          busy={busy}
          onSelectProject={(key) => {
            selectProject(key)
            setView("project")
            void refreshRuns(true, key)
          }}
          onNewProject={openNewProject}
          onEditProject={openEditProject}
          onToggleProject={(project, enabled) => void toggleProjectEnabled(project, enabled)}
          onToggleDaemon={(enabled) => void setDaemonEnabled(enabled)}
          onActivity={openGlobalActivity}
          onLogs={() => setView("logs")}
          onSettings={() => setView("settings")}
        />

        <section className="flex min-h-0 min-w-0 flex-col overflow-x-hidden px-3 py-3 sm:px-5 sm:py-4">
          <header className="mb-3 flex shrink-0 flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-normal">
                {viewTitle(view, selectedProject)}
              </h1>
              {view === "project" && selectedProject && (
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{selectedProject.key}</span>
                  <span className="min-w-0 truncate">{selectedProject.path || selectedProject.codexCwd}</span>
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" onClick={() => void refreshCurrentView()} disabled={busy}>
                <RefreshCcw className="size-4" />
                刷新
              </Button>
              <Button onClick={() => void validateConfig()} disabled={busy}>
                <CheckCircle2 className="size-4" />
                校验
              </Button>
            </div>
          </header>

          <div className={view === "project" ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-1"}>
            {view === "project" && (
              <ProjectView
                project={selectedProject}
                runs={projectRuns}
                runTotalCount={runTotalCount}
                activeRuns={activeProjectRuns}
                codexAgents={projectCodexAgents}
                selectedRun={selectedRun}
                manualStage={manualStage}
                manualIssue={manualIssue}
                manualForce={manualForce}
                busy={busy}
                manualRunSubmitting={manualRunSubmitting}
                setManualStage={setManualStage}
                setManualIssue={setManualIssue}
                setManualForce={setManualForce}
                refreshRuns={() => void refreshRuns()}
                loadRun={loadRun}
                triggerOnce={(stage, issueId, projectKey, force) => void triggerOnce(stage, issueId, projectKey, force)}
                retryRun={retryRun}
                cancelRun={(id) => void cancelRun(id)}
                cancelProject={(key) => void cancelProject(key)}
                editProject={(project) => openEditProject(project)}
                addProject={openNewProject}
              />
            )}

            {view === "activity" && (
              <GlobalActivityView
                projects={config.projects}
                runs={globalRuns}
                runTotalCount={globalRunTotalCount}
                activeRuns={daemon?.activeRuns || []}
                agents={globalCodexActivity.agents}
                generatedAt={globalCodexActivity.generatedAt}
                busy={busy}
                manualRunSubmitting={manualRunSubmitting}
                refreshActivity={() => void refreshGlobalActivity()}
                loadRun={(id) => void loadRun(id)}
                retryRun={retryRun}
                cancelRun={(id) => void cancelRun(id)}
                selectedRun={selectedRun}
              />
            )}

            {view === "logs" && <LogsPage events={events} />}

            {view === "settings" && (
              <SettingsPage
                config={config}
                prompts={prompts}
                projectKeys={activeProjectKeys}
                promptScope={promptScope}
                promptStage={promptStage}
                promptText={promptText}
                setConfig={setConfig}
                saveConfig={() => void saveConfig(config)}
                setPromptScope={setPromptScope}
                setPromptStage={setPromptStage}
                setPromptText={setPromptText}
                savePrompt={() => void savePrompt()}
                busy={busy}
              />
            )}
          </div>
        </section>
      </div>
      <ProjectEditor
        open={projectEditorOpen}
        project={draftProject}
        editing={Boolean(editingProjectKey)}
        busy={busy}
        onOpenChange={setProjectEditorOpen}
        onUpdate={updateDraftProject}
        onSave={() => void saveDraftProject()}
        saveDisabled={Boolean(projectKeyError)}
        validationMessage={projectKeyError}
        onRemove={editingProjectKey ? () => void removeProject(editingProjectKey) : undefined}
      />
      <Toaster />
    </main>
  )
}

function Sidebar({
  config,
  daemon,
  selectedProjectKey,
  view,
  busy,
  onSelectProject,
  onNewProject,
  onEditProject,
  onToggleProject,
  onToggleDaemon,
  onActivity,
  onLogs,
  onSettings,
}: {
  config: AppConfig
  daemon: DaemonStatus | null
  selectedProjectKey: string
  view: View
  busy: boolean
  onSelectProject: (key: string) => void
  onNewProject: () => void
  onEditProject: (project: ProjectConfig) => void
  onToggleProject: (project: ProjectConfig, enabled: boolean) => void
  onToggleDaemon: (enabled: boolean) => void
  onActivity: () => void
  onLogs: () => void
  onSettings: () => void
}) {
  return (
    <aside className="flex max-h-[44svh] min-h-0 flex-col border-b bg-sidebar text-sidebar-foreground md:h-svh md:max-h-none md:border-r md:border-b-0">
      <div className="flex shrink-0 items-center justify-between px-3 py-3 md:px-4 md:py-4">
        <button
          type="button"
          className={[
            "flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors",
            view === "activity" ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70",
          ].join(" ")}
          onClick={onActivity}
          aria-label="打开全局小人展示"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-sidebar-border">
            <img src={APP_LOGO_SRC} alt="WorkAutomation logo" className="size-6 object-contain" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{APP_BRAND_NAME}</div>
            <div className="truncate text-xs text-muted-foreground">{config.serverId}</div>
          </div>
        </button>
        <Button size="icon" variant="ghost" onClick={onNewProject} disabled={busy} aria-label="新建项目">
          <Plus className="size-4" />
        </Button>
      </div>

      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-3">
          {config.projects.map((project) => (
            <ProjectNavItem
              key={project.key}
              project={project}
              active={view === "project" && selectedProjectKey === project.key}
              busy={busy}
              onSelect={() => onSelectProject(project.key)}
              onEdit={() => onEditProject(project)}
              onToggle={(enabled) => onToggleProject(project, enabled)}
            />
          ))}
          {config.projects.length === 0 && (
            <div className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
              尚未配置项目
            </div>
          )}
        </div>
      </ScrollArea>

      <Separator />

      <div className="grid shrink-0 grid-cols-[1fr_auto_auto] gap-2 p-3 md:block md:space-y-3">
        <div className="rounded-lg border bg-background/70 px-3 py-2 md:py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">轮询</div>
              <div className="text-xs text-muted-foreground">
                {daemon?.enabled ? "已启动" : "已停止"} · {daemon?.running ? "执行中" : "空闲"}
              </div>
            </div>
            <Switch
              checked={Boolean(daemon?.enabled)}
              disabled={busy}
              onCheckedChange={(checked) => onToggleDaemon(checked)}
            />
          </div>
          <div className="mt-2 hidden text-xs text-muted-foreground md:block">
            下次扫描: {daemon?.nextRunAt ? formatDate(daemon.nextRunAt) : "-"}
          </div>
          {daemon?.lastError && <div className="mt-2 text-xs text-destructive">错误: {daemon.lastError}</div>}
        </div>
        <Button
          variant={view === "logs" ? "secondary" : "ghost"}
          className="h-full justify-center md:h-auto md:w-full md:justify-start"
          onClick={onLogs}
        >
          <ScrollText className="size-4" />
          <span className="hidden md:inline">全局日志</span>
        </Button>
        <Button
          variant={view === "settings" ? "secondary" : "ghost"}
          className="h-full justify-center md:h-auto md:w-full md:justify-start"
          onClick={onSettings}
        >
          <Settings className="size-4" />
          <span className="hidden md:inline">设置</span>
        </Button>
      </div>
    </aside>
  )
}

function ProjectNavItem({
  project,
  active,
  busy,
  onSelect,
  onEdit,
  onToggle,
}: {
  project: ProjectConfig
  active: boolean
  busy: boolean
  onSelect: () => void
  onEdit: () => void
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div
      className={[
        "min-w-0 rounded-lg border px-2 py-2 transition-colors",
        active ? "border-sidebar-ring bg-sidebar-accent" : "border-transparent hover:bg-sidebar-accent/70",
      ].join(" ")}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          onSelect()
        }
      }}
    >
      <div className="flex items-center gap-2">
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{project.repoName || project.key}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{project.key}</div>
        </div>
        <Switch
          checked={project.enabled}
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={onToggle}
        />
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            onEdit()
          }}
          aria-label="修改项目"
        >
          <Pencil className="size-4" />
        </Button>
      </div>
    </div>
  )
}

function ProjectView({
  project,
  runs,
  runTotalCount,
  activeRuns,
  codexAgents,
  selectedRun,
  manualStage,
  manualIssue,
  manualForce,
  busy,
  manualRunSubmitting,
  setManualStage,
  setManualIssue,
  setManualForce,
  refreshRuns,
  loadRun,
  triggerOnce,
  retryRun,
  cancelRun,
  cancelProject,
  editProject,
  addProject,
}: {
  project: ProjectConfig | null
  runs: RunSummary[]
  runTotalCount: number
  activeRuns: DaemonStatus["activeRuns"]
  codexAgents: CodexActivityAgent[]
  selectedRun: RunDetail | null
  manualStage: Stage
  manualIssue: string
  manualForce: boolean
  busy: boolean
  manualRunSubmitting: boolean
  setManualStage: (stage: Stage) => void
  setManualIssue: (issue: string) => void
  setManualForce: (force: boolean) => void
  refreshRuns: () => void
  loadRun: (id: string) => Promise<boolean>
  triggerOnce: (stage: Stage, issueId?: string, projectKey?: string, force?: boolean) => void
  retryRun: (run: RunDetail | RunSummary) => void
  cancelRun: (id: string) => void
  cancelProject: (key: string) => void
  editProject: (project: ProjectConfig) => void
  addProject: () => void
}) {
  const shouldUseRunDialog = useMediaQuery("(max-width: 1535px)")
  const [runDialogOpen, setRunDialogOpen] = useState(false)

  useEffect(() => {
    if (!shouldUseRunDialog) {
      setRunDialogOpen(false)
    }
  }, [shouldUseRunDialog])

  const handleRunSelect = async (id: string) => {
    const loaded = await loadRun(id)
    if (loaded && shouldUseRunDialog) {
      setRunDialogOpen(true)
    }
  }

  if (!project) {
    return (
      <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-dashed bg-background">
        <Button onClick={addProject}>
          <Plus className="size-4" />
          新建项目
        </Button>
      </div>
    )
  }

  const lastRun = runs[0]

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1 2xl:overflow-hidden 2xl:pr-0">
      <div className="grid min-w-0 shrink-0 grid-cols-3 gap-2 sm:gap-3">
        <MetricCard title="当前执行" value={String(activeRuns.length)} />
        <MetricCard title="历史运行" value={String(runTotalCount)} />
        <MetricCard title="最近状态" value={lastRun ? runStatusLabel(lastRun.status) : "-"} />
      </div>

      <CodexActivityPanel
        agents={codexAgents}
        project={project}
        lastRun={lastRun}
        busy={busy}
        onRefresh={refreshRuns}
        onCancelRun={cancelRun}
        onSelectRun={(id) => void loadRun(id)}
      />

      <div className="grid min-h-[520px] min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] 2xl:min-h-0 2xl:grid-cols-[minmax(360px,0.75fr)_minmax(420px,0.9fr)_minmax(0,1.2fr)]">
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <Card className="shrink-0">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>当前项目</CardTitle>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => editProject(project)} disabled={busy}>
                    <Pencil className="size-4" />
                    修改
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => cancelProject(project.key)}
                    disabled={busy || activeRuns.length === 0}
                  >
                    <StopCircle className="size-4" />
                    停止项目
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <InfoItem label="仓库" value={project.repoName || "-"} />
              <InfoItem label="状态" value={project.enabled ? "启用" : "停用"} />
              <InfoItem label="Linear 项目 ID" value={project.linearProjectId || "-"} />
              <InfoItem label="阶段二上限" value={String(project.maxActivePart2)} />
              <InfoItem label="仓库路径" value={project.path || "-"} wide />
              <InfoItem label="Codex 路径" value={project.codexCwd || project.path || "-"} wide />
            </CardContent>
          </Card>

          <Card className="shrink-0">
            <CardHeader>
              <CardTitle>执行</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-[150px_1fr_auto]">
              <Select value={manualStage} onValueChange={(value) => setManualStage(value as Stage)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">全部</SelectItem>
                  <SelectItem value="part1">阶段一</SelectItem>
                  <SelectItem value="part2">阶段二</SelectItem>
                  <SelectItem value="part3">阶段三 / Auto Review</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="可选 issue ID，例如 LIV-123"
                value={manualIssue}
                onChange={(event) => setManualIssue(event.target.value)}
              />
              <Button
                className="w-full sm:w-auto"
                onClick={() => triggerOnce(manualStage, manualIssue.trim() || undefined, project.key, manualForce)}
                disabled={busy || manualRunSubmitting}
              >
                <Play className="size-4" />
                {manualRunSubmitting ? "提交中" : "执行"}
              </Button>
              <div className="col-span-full flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="space-y-1">
                  <div className="text-sm font-medium">强制执行</div>
                  <div className="text-xs leading-5 text-muted-foreground">
                    不填 issue ID 时会绕过“已处理快照”跳过；填写 issue ID 且显式选择某个阶段时，会按所选阶段强制重跑。
                  </div>
                </div>
                <Switch checked={manualForce} onCheckedChange={setManualForce} />
              </div>
            </CardContent>
          </Card>

        </div>

        <RunHistoryCard
          className="min-h-[360px] lg:min-h-0"
          runs={runs}
          busy={busy}
          refreshRuns={refreshRuns}
          loadRun={handleRunSelect}
        />

        <div className="hidden min-h-0 2xl:block">
          <RunDetailPanel
            selectedRun={selectedRun}
            manualRunSubmitting={manualRunSubmitting}
            onRetry={retryRun}
          />
        </div>
      </div>

      <RunDetailDialog
        open={runDialogOpen}
        onOpenChange={setRunDialogOpen}
        selectedRun={selectedRun}
        manualRunSubmitting={manualRunSubmitting}
        onRetry={retryRun}
      />
    </div>
  )
}

function GlobalActivityView({
  projects,
  runs,
  runTotalCount,
  activeRuns,
  agents,
  generatedAt,
  busy,
  manualRunSubmitting,
  refreshActivity,
  loadRun,
  retryRun,
  cancelRun,
  selectedRun,
}: {
  projects: ProjectConfig[]
  runs: RunSummary[]
  runTotalCount: number
  activeRuns: DaemonStatus["activeRuns"]
  agents: CodexActivityAgent[]
  generatedAt: string
  busy: boolean
  manualRunSubmitting: boolean
  refreshActivity: () => void
  loadRun: (id: string) => void
  retryRun: (run: RunDetail | RunSummary) => void
  cancelRun: (id: string) => void
  selectedRun: RunDetail | null
}) {
  const activeProjectCount = useMemo(() => {
    const projectKeys = new Set<string>()
    for (const run of activeRuns) {
      projectKeys.add(run.projectKey)
    }
    for (const agent of agents) {
      projectKeys.add(agent.projectKey)
    }
    return projectKeys.size
  }, [activeRuns, agents])
  const lastRun = runs[0]
  const globalDescription = globalRoomDescription(agents, activeRuns, lastRun)

  if (projects.length === 0) {
    return (
      <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-dashed bg-background text-sm text-muted-foreground">
        尚未配置项目
      </div>
    )
  }

  return (
    <div className="space-y-5 pb-6">
      <div className="grid grid-cols-3 gap-4">
        <MetricCard title="项目数" value={String(projects.length)} />
        <MetricCard title="活跃项目" value={String(activeProjectCount)} />
        <MetricCard title="历史运行" value={String(runTotalCount)} />
      </div>

      <div className="flex justify-end font-mono text-xs text-muted-foreground">
        更新: {generatedAt ? formatDate(generatedAt) : "-"}
      </div>

      <CodexActivityPanel
        agents={agents}
        projects={projects}
        lastRun={lastRun}
        contextKey={`global:${projects.map((project) => project.key).join("|")}`}
        sceneClassName="h-[min(72vh,760px)] min-h-[460px]"
        title="全局小人展示"
        description={globalDescription}
        busy={busy}
        onRefresh={refreshActivity}
        onCancelRun={cancelRun}
        onSelectRun={loadRun}
      />

      {selectedRun && (
        <div className="h-[360px] min-h-0">
          <RunDetailPanel
            selectedRun={selectedRun}
            manualRunSubmitting={manualRunSubmitting}
            onRetry={retryRun}
          />
        </div>
      )}
    </div>
  )
}

function MetricCard({ title, value }: { title: string; value: string }) {
  return (
    <Card size="sm" className="min-h-14 min-w-0 justify-center gap-0 py-2 sm:min-h-16">
      <CardContent className="flex min-w-0 items-center justify-between gap-2 px-2 sm:px-3">
        <div className="min-w-0 truncate whitespace-nowrap text-xs font-medium text-muted-foreground">
          {title}
        </div>
        <div className="min-w-0 truncate text-right text-base font-semibold leading-none sm:text-lg">
          {value}
        </div>
      </CardContent>
    </Card>
  )
}

function InfoItem({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-words font-mono text-xs">{value}</div>
    </div>
  )
}

function runFailureSummary(run: Partial<RunSummary> & { stdout?: string; stderr?: string; final?: string }) {
  if (run.status !== "failed") {
    return ""
  }
  if (run.failureSummary?.trim()) return run.failureSummary.trim()
  const genericExitError =
    run.codexStarted === false && /^Codex 退出码为 \d+$/u.test(run.error?.trim() || "")
  if (!genericExitError && run.error?.trim()) return run.error.trim()
  if (run.startupError?.trim()) return run.startupError.trim()
  if (genericExitError || run.exitCode != null) {
    const exitCode =
      run.exitCode ??
      Number.parseInt((run.error || "").replace("Codex 退出码为", "").trim(), 10)
    return run.codexStarted === false
      ? `Codex 子进程未成功启动（退出码 ${Number.isFinite(exitCode) ? exitCode : 1}）`
      : `Codex 退出码为 ${Number.isFinite(exitCode) ? exitCode : 1}`
  }
  return "运行失败"
}

function runFailureHint(run: Partial<RunDetail>) {
  if (run.status !== "failed") {
    return ""
  }
  if (run.failureAction?.trim()) {
    return run.failureAction.trim()
  }
  const hasArtifacts = Boolean(run.stdout?.trim() || run.stderr?.trim() || run.final?.trim())
  if (run.codexStarted === false && !hasArtifacts) {
    return "当前记录没有 stdout、stderr 或 final 输出。常见原因是服务进程 PATH 中没有 `codex`，或 Codex CLI 无法在当前非交互环境启动。"
  }
  return ""
}

function RunHistoryCard({
  runs,
  busy,
  refreshRuns,
  loadRun,
  className,
}: {
  runs: RunSummary[]
  busy: boolean
  refreshRuns: () => void
  loadRun: (id: string) => void
  className?: string
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>历史</CardTitle>
          <Button variant="outline" size="sm" onClick={refreshRuns} disabled={busy}>
            <RefreshCcw className="size-4" />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full rounded-lg border">
          <RunTable runs={runs} loadRun={loadRun} />
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function RunTable({ runs, loadRun }: { runs: RunSummary[]; loadRun: (id: string) => void }) {
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <TableHead>事项</TableHead>
          <TableHead>阶段</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>时间</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow
            key={run.id}
            className="cursor-pointer"
            title={`更新时间: ${formatDate(run.updatedAt)}`}
            onClick={() => loadRun(run.id)}
          >
            <TableCell>
              <div className="font-mono text-xs">{run.issueIdentifier}</div>
              <div className="max-w-[260px] truncate text-xs text-muted-foreground">{run.issueTitle}</div>
              {run.status === "failed" && runFailureSummary(run) && (
                <div className="mt-1 max-w-[320px] truncate text-xs text-destructive">
                  {runFailureSummary(run)}
                </div>
              )}
            </TableCell>
            <TableCell>{stageLabel(run.stage)}</TableCell>
            <TableCell>
              <StatusBadge status={run.status} />
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
              {formatDate(run.updatedAt)}
            </TableCell>
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
  )
}

function RunDetailDialog({
  open,
  onOpenChange,
  selectedRun,
  manualRunSubmitting,
  onRetry,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedRun: RunDetail | null
  manualRunSubmitting: boolean
  onRetry: (run: RunDetail | RunSummary) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(86svh,760px)] max-w-[calc(100vw-1rem)] grid-rows-[1fr] p-3 sm:max-w-[min(980px,calc(100vw-2rem))] sm:p-4">
        <DialogTitle className="sr-only">运行详情</DialogTitle>
        <DialogDescription className="sr-only">
          查看选中历史运行的最终结果、标准输出、错误输出和提示词。
        </DialogDescription>
        <div className="min-h-0 min-w-0">
          <RunDetailPanel
            selectedRun={selectedRun}
            manualRunSubmitting={manualRunSubmitting}
            onRetry={onRetry}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RunDetailPanel({
  selectedRun,
  manualRunSubmitting,
  onRetry,
}: {
  selectedRun: RunDetail | null
  manualRunSubmitting: boolean
  onRetry: (run: RunDetail | RunSummary) => void
}) {
  const failureSummary = selectedRun ? runFailureSummary(selectedRun) : ""
  const failureHint = selectedRun ? runFailureHint(selectedRun) : ""
  const canRetry = Boolean(selectedRun?.status === "failed" && selectedRun.issueIdentifier && selectedRun.projectKey)
  return (
    <Card className="h-full min-h-0 min-w-0 overflow-hidden">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>运行详情</CardTitle>
          {selectedRun && canRetry && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRetry(selectedRun)}
              disabled={manualRunSubmitting}
            >
              <RefreshCcw className="size-4" />
              {manualRunSubmitting ? "提交中" : "重试此事项"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {selectedRun ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-3 text-xs">
              <InfoItem label="事项" value={selectedRun.issueIdentifier || "-"} />
              <InfoItem label="状态" value={runStatusLabel(selectedRun.status)} />
              <InfoItem label="阶段" value={stageLabel(selectedRun.stage)} />
              <InfoItem label="退出码" value={selectedRun.exitCode == null ? "-" : String(selectedRun.exitCode)} />
              <InfoItem label="Codex PID" value={selectedRun.codexPid == null ? "-" : String(selectedRun.codexPid)} />
              <InfoItem label="更新时间" value={formatDate(selectedRun.updatedAt)} />
            </div>
            {failureSummary && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <div className="font-medium">失败摘要</div>
                <div className="mt-1 whitespace-pre-wrap break-words">{failureSummary}</div>
                {failureHint && (
                  <div className="mt-2 text-xs leading-5 text-destructive/90">{failureHint}</div>
                )}
              </div>
            )}
            <Tabs defaultValue="final" className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
              <TabsList className="max-w-full shrink-0 overflow-x-auto">
                <TabsTrigger value="final">最终结果</TabsTrigger>
                <TabsTrigger value="stdout">标准输出</TabsTrigger>
                <TabsTrigger value="stderr">错误输出</TabsTrigger>
                <TabsTrigger value="prompt">提示词</TabsTrigger>
              </TabsList>
              <RunLog value="final" text={selectedRun.final || JSON.stringify(selectedRun.finalJson, null, 2) || ""} />
              <RunStdoutLog text={selectedRun.stdout} />
              <RunLog value="stderr" text={selectedRun.stderr} />
              <RunLog value="prompt" text={selectedRun.prompt} />
            </Tabs>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            <CircleDot className="mr-2 size-4" />
            未选择运行记录
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RunStdoutLog({ text }: { text: string }) {
  const parsed = useMemo(() => parseCodexStdout(text), [text])
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set())
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    setExpandedEventIds(new Set())
    setShowRaw(false)
  }, [text])

  if (!parsed.isStructured) {
    return <RunLog value="stdout" text={text} />
  }

  const toggleEvent = (id: string) => {
    setExpandedEventIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <TabsContent value="stdout" className="mt-3 min-h-0 min-w-0 overflow-hidden">
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border bg-background p-2">
          <StdoutStatChip label="事件" value={parsed.stats.eventCount} />
          <StdoutStatChip label="消息" value={parsed.stats.messageCount} />
          <StdoutStatChip label="命令" value={parsed.stats.commandCount} />
          <StdoutStatChip label="工具" value={parsed.stats.toolCount} />
          <StdoutStatChip label="错误" value={parsed.stats.errorCount} />
          <StdoutStatChip label="长输出" value={parsed.stats.longEventCount} />
          <StdoutStatChip label="原始" value={formatBytes(parsed.stats.rawBytes)} />
          {parsed.stats.malformedLines > 0 && (
            <Badge variant="outline">解析跳过 {parsed.stats.malformedLines} 行</Badge>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">最新优先</span>
            <Button type="button" variant="outline" size="xs" onClick={() => setShowRaw((current) => !current)}>
              <FileJson className="size-3" />
              {showRaw ? "隐藏原始 JSONL" : "原始 JSONL"}
            </Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background">
          <div className="space-y-1.5 p-2">
            {showRaw ? (
              <div className="rounded-lg border bg-muted/40 p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-xs font-medium">原始 JSONL</div>
                  <div className="text-xs text-muted-foreground">
                    {parsed.stats.rawLines} 行 · {formatBytes(parsed.stats.rawBytes)}
                  </div>
                </div>
                <pre className="max-h-[520px] min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
                  {parsed.rawText || "（空）"}
                </pre>
              </div>
            ) : (
              parsed.events.map((event) => (
                <StdoutEventRow
                  key={event.id}
                  event={event}
                  expanded={expandedEventIds.has(event.id)}
                  onToggle={() => toggleEvent(event.id)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </TabsContent>
  )
}

function StdoutStatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted/50 px-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </span>
  )
}

function StdoutEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: CodexStdoutEvent
  expanded: boolean
  onToggle: () => void
}) {
  const hasDetail = event.canExpand && Boolean(event.detail)

  return (
    <div className="grid min-w-0 grid-cols-[auto_1fr] gap-2 rounded-md border bg-card px-2 py-1.5 text-xs">
      <div className="flex w-[86px] shrink-0 flex-col items-start gap-1">
        <StdoutKindBadge kind={event.kind} />
        <StdoutStatusBadge status={event.status} />
        <span className="font-mono text-[11px] text-muted-foreground">#{event.lineNumber}</span>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="break-words font-medium leading-snug">{event.title || stdoutKindLabel(event.kind)}</div>
            {event.summary && event.summary !== event.title && (
              <div className="mt-0.5 break-words text-muted-foreground">{event.summary}</div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {event.outputBytes > 0 && (
              <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
                {formatBytes(event.outputBytes)}
              </span>
            )}
            {hasDetail && (
              <Button type="button" variant="ghost" size="xs" onClick={onToggle}>
                {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {expanded ? "收起" : "展开"}
              </Button>
            )}
          </div>
        </div>
        {event.preview && (
          <pre className="mt-1 max-h-16 min-w-0 overflow-hidden whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {event.preview}
          </pre>
        )}
        {expanded && hasDetail && (
          <pre className="mt-1 max-h-[420px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
            {event.detail}
          </pre>
        )}
      </div>
    </div>
  )
}

function StdoutKindBadge({ kind }: { kind: CodexStdoutEventKind }) {
  if (kind === "error") return <Badge variant="destructive">错误</Badge>
  if (kind === "command") return <Badge>命令</Badge>
  if (kind === "tool") return <Badge variant="secondary">工具</Badge>
  if (kind === "message") return <Badge variant="outline">消息</Badge>
  return <Badge variant="outline">{stdoutKindLabel(kind)}</Badge>
}

function StdoutStatusBadge({ status }: { status: CodexStdoutEventStatus }) {
  if (status === "failed") return <Badge variant="destructive">失败</Badge>
  if (status === "running") return <Badge variant="secondary">运行中</Badge>
  if (status === "completed") return <Badge variant="outline">完成</Badge>
  if (status === "updated") return <Badge variant="outline">更新</Badge>
  return <Badge variant="outline">事件</Badge>
}

function stdoutKindLabel(kind: CodexStdoutEventKind) {
  if (kind === "message") return "消息"
  if (kind === "command") return "命令"
  if (kind === "tool") return "工具"
  if (kind === "file") return "文件"
  if (kind === "todo") return "清单"
  if (kind === "search") return "搜索"
  if (kind === "lifecycle") return "生命周期"
  if (kind === "error") return "错误"
  return "其他"
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function RunLog({ value, text }: { value: string; text: string }) {
  return (
    <TabsContent value={value} className="mt-3 min-h-0 min-w-0 overflow-hidden">
      <ScrollArea className="h-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-background p-3">
        <pre className="min-w-0 max-w-full whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{text || "（空）"}</pre>
      </ScrollArea>
    </TabsContent>
  )
}

function ProjectEditor({
  open,
  project,
  editing,
  busy,
  onOpenChange,
  onUpdate,
  onSave,
  saveDisabled = false,
  validationMessage,
  onRemove,
}: {
  open: boolean
  project: ProjectConfig
  editing: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onUpdate: (patch: Partial<ProjectConfig>) => void
  onSave: () => void
  saveDisabled?: boolean
  validationMessage?: string | null
  onRemove?: () => void
}) {
  const [linearProjectPickerOpen, setLinearProjectPickerOpen] = useState(false)
  const [linearProjectFilter, setLinearProjectFilter] = useState("")
  const [linearProjectOptions, setLinearProjectOptions] = useState<LinearProjectOption[]>([])
  const [linearProjectLoading, setLinearProjectLoading] = useState(false)
  const [linearProjectError, setLinearProjectError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setLinearProjectPickerOpen(false)
      setLinearProjectFilter("")
      setLinearProjectError(null)
      setLinearProjectLoading(false)
      return
    }
  }, [open])

  const filteredLinearProjects = useMemo(() => {
    const query = linearProjectFilter.trim().toLowerCase()
    if (!query) return linearProjectOptions
    return linearProjectOptions.filter((item) =>
      [item.displayName, item.name, item.id, item.teamNames.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(query),
    )
  }, [linearProjectFilter, linearProjectOptions])

  async function openLinearProjectPicker() {
    setLinearProjectPickerOpen(true)
    setLinearProjectLoading(true)
    setLinearProjectError(null)
    try {
      const response = await api.listLinearProjects()
      setLinearProjectOptions(response.projects)
    } catch (error) {
      setLinearProjectError(errorMessage(error))
    } finally {
      setLinearProjectLoading(false)
    }
  }

  function selectLinearProject(item: LinearProjectOption) {
    onUpdate({ linearProjectId: item.id })
    setLinearProjectPickerOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[720px] overflow-y-auto sm:max-w-[720px]">
        <SheetHeader>
          <SheetTitle>{editing ? "修改项目" : "新建项目"}</SheetTitle>
        </SheetHeader>
        <div className="grid grid-cols-2 gap-3 px-4">
          <Field label="仓库名称" description={projectFieldDescriptions.repoName}>
            <Input value={project.repoName} onChange={(event) => onUpdate({ repoName: event.target.value })} />
          </Field>
          <Field label="Linear 项目 ID" description={projectFieldDescriptions.linearProjectId}>
            <div className="flex gap-2">
              <Input
                className="font-mono"
                value={project.linearProjectId}
                onChange={(event) => onUpdate({ linearProjectId: event.target.value })}
              />
              <Button type="button" variant="outline" onClick={() => void openLinearProjectPicker()} disabled={busy || linearProjectLoading}>
                <RefreshCcw className={cn("size-4", linearProjectLoading && "animate-spin")} />
                选择
              </Button>
            </div>
          </Field>
          <Field label="分支 / 提交范围前缀" description={projectFieldDescriptions.branchOrScopePrefix}>
            <Input
              value={project.branchOrScopePrefix}
              onChange={(event) => onUpdate({ branchOrScopePrefix: event.target.value })}
            />
          </Field>
          <Field label="仓库路径" description={projectFieldDescriptions.path}>
            <Input
              value={project.path}
              onChange={(event) => {
                const nextPath = event.target.value
                const shouldSyncCodexCwd = !project.codexCwd || project.codexCwd === project.path
                onUpdate({
                  path: nextPath,
                  ...(shouldSyncCodexCwd ? { codexCwd: nextPath } : {}),
                })
              }}
            />
          </Field>
          <Field label="Codex 执行路径" description={projectFieldDescriptions.codexCwd}>
            <Input value={project.codexCwd} onChange={(event) => onUpdate({ codexCwd: event.target.value })} />
          </Field>
          <Field label="阶段二并发上限" description={projectFieldDescriptions.maxActivePart2}>
            <Input
              type="number"
              value={project.maxActivePart2}
              onChange={(event) => onUpdate({ maxActivePart2: Number(event.target.value) })}
            />
          </Field>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <Label>启用</Label>
            <Switch checked={project.enabled} onCheckedChange={(checked) => onUpdate({ enabled: checked })} />
          </div>
          <Field label="阶段一提示词模式">
            <ModeSelect value={project.part1PromptMode} onValueChange={(value) => onUpdate({ part1PromptMode: value })} />
          </Field>
          <Field label="阶段二提示词模式">
            <ModeSelect value={project.part2PromptMode} onValueChange={(value) => onUpdate({ part2PromptMode: value })} />
          </Field>
          <Field label="阶段三提示词模式">
            <ModeSelect value={project.part3PromptMode} onValueChange={(value) => onUpdate({ part3PromptMode: value })} />
          </Field>
          <Field label="默认测试命令" description={projectFieldDescriptions.defaultTests} className="col-span-2">
            <Textarea
              className="min-h-24 font-mono text-xs"
              value={project.defaultTests.join("\n")}
              onChange={(event) =>
                onUpdate({
                  defaultTests: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="项目规则" description={projectFieldDescriptions.extraRules} className="col-span-2">
            <Textarea
              className="min-h-24"
              value={project.extraRules}
              onChange={(event) => onUpdate({ extraRules: event.target.value })}
            />
          </Field>
        </div>
        <SheetFooter>
          {validationMessage && (
            <p className="mr-auto max-w-[420px] text-sm text-destructive">{validationMessage}</p>
          )}
          {onRemove && (
            <Button variant="destructive" onClick={onRemove} disabled={busy}>
              <Trash2 className="size-4" />
              删除
            </Button>
          )}
          <Button onClick={onSave} disabled={busy || saveDisabled}>
            <Save className="size-4" />
            保存
          </Button>
        </SheetFooter>
      </SheetContent>

      <Dialog open={linearProjectPickerOpen} onOpenChange={setLinearProjectPickerOpen}>
        <DialogContent className="max-h-[min(82svh,720px)] max-w-[min(900px,calc(100vw-2rem))] grid-rows-[auto_1fr] overflow-hidden p-0">
          <div className="flex flex-col gap-4 p-4 pb-0">
            <div className="space-y-1">
              <DialogTitle>选择 Linear 项目</DialogTitle>
              <DialogDescription>
                点击按钮会实时拉取当前 Linear workspace 的项目列表，选择后自动回填项目 UUID。
              </DialogDescription>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="按 display name、team 或 UUID 过滤"
                value={linearProjectFilter}
                onChange={(event) => setLinearProjectFilter(event.target.value)}
              />
              <Button type="button" variant="outline" onClick={() => void openLinearProjectPicker()} disabled={linearProjectLoading}>
                <RefreshCcw className={cn("size-4", linearProjectLoading && "animate-spin")} />
                刷新
              </Button>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>共 {linearProjectOptions.length} 个项目</span>
              <span>当前值: {project.linearProjectId || "未填写"}</span>
            </div>
          </div>
          <ScrollArea className="min-h-0 px-4 pb-4">
            <div className="space-y-2">
              {linearProjectError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {linearProjectError}
                </div>
              )}
              {!linearProjectError && linearProjectLoading && linearProjectOptions.length === 0 && (
                <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  正在从 Linear 拉取项目列表...
                </div>
              )}
              {!linearProjectError && !linearProjectLoading && linearProjectOptions.length === 0 && (
                <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  未拉取到任何 Linear 项目。
                </div>
              )}
              {!linearProjectError && !linearProjectLoading && linearProjectOptions.length > 0 && filteredLinearProjects.length === 0 && (
                <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  没有匹配当前过滤条件的项目。
                </div>
              )}
              {filteredLinearProjects.map((item) => {
                const selected = item.id === project.linearProjectId
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
                      selected && "border-primary bg-primary/5",
                    )}
                    onClick={() => selectLinearProject(item)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{item.displayName}</div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">{item.id}</div>
                        {item.teamNames.length > 0 && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            Teams: {item.teamNames.join(", ")}
                          </div>
                        )}
                      </div>
                      <Badge variant={selected ? "default" : "outline"}>
                        {selected ? "当前已选" : "选择"}
                      </Badge>
                    </div>
                  </button>
                )
              })}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </Sheet>
  )
}

function SettingsPage({
  config,
  prompts,
  projectKeys,
  promptScope,
  promptStage,
  promptText,
  setConfig,
  saveConfig,
  setPromptScope,
  setPromptStage,
  setPromptText,
  savePrompt,
  busy,
}: {
  config: AppConfig
  prompts: PromptBundle
  projectKeys: string[]
  promptScope: string
  promptStage: PromptStage
  promptText: string
  setConfig: (config: AppConfig) => void
  saveConfig: () => void
  setPromptScope: (scope: string) => void
  setPromptStage: (stage: PromptStage) => void
  setPromptText: (text: string) => void
  savePrompt: () => void
  busy: boolean
}) {
  return (
    <div className="space-y-4">
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
            <Field label="Linear API 密钥环境变量" description="这里只填写环境变量名；密钥值只放在启动服务的进程环境中。">
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
            <div className="grid grid-cols-3 gap-3">
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
              <Field label="阶段三沙箱">
                <Input
                  value={config.codex.part3Sandbox}
                  onChange={(event) =>
                    setConfig({ ...config, codex: { ...config.codex, part3Sandbox: event.target.value } })
                  }
                />
              </Field>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Linear 状态</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            状态名称必须和 Linear 工作流中的名称完全一致。阶段一只扫描待处理、需要澄清和阻塞状态；阶段二只扫描已排期状态；阶段三只扫描 Testing。Ready for Codex 到 On Schedule 需要用户人工批准，阶段三完成后最小支持流转到 Ready for Review 或回到 On Schedule。
          </p>
          <div className="grid grid-cols-4 gap-3">
            {(Object.entries(config.statuses) as Array<[keyof AppConfig["statuses"], string]>).map(([key, value]) => (
              <Field key={key} label={statusConfigLabel(key)} description={statusConfigDescriptions[key]}>
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>提示词</CardTitle>
            <Button onClick={savePrompt} disabled={busy}>
              <Save className="size-4" />
              保存
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Tabs value={promptStage} onValueChange={(value) => setPromptStage(value as PromptStage)}>
              <TabsList>
                <TabsTrigger value="part1">阶段一</TabsTrigger>
                <TabsTrigger value="part2">阶段二</TabsTrigger>
                <TabsTrigger value="part3">阶段三</TabsTrigger>
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
                    {prompts.projects[key]?.part1IsOverride ||
                    prompts.projects[key]?.part2IsOverride ||
                    prompts.projects[key]?.part3IsOverride
                      ? `${key}`
                      : key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            className="h-[52svh] min-h-80 max-h-[680px] resize-none overflow-auto font-mono text-xs leading-relaxed"
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function LogsPage({ events }: { events: ExecutionEvent[] }) {
  const skipEvents = events.filter(
    (event) => event.type.includes("skip") || event.message.includes("跳过"),
  )
  const errorEvents = events.filter((event) => event.level === "error")
  const latestSkip = skipEvents[0]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <MetricCard title="日志总数" value={String(events.length)} />
        <MetricCard title="跳过记录" value={String(skipEvents.length)} />
        <MetricCard title="错误记录" value={String(errorEvents.length)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>最近跳过</CardTitle>
        </CardHeader>
        <CardContent>
          {latestSkip ? (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{latestSkip.type}</Badge>
                {latestSkip.projectKey && <Badge variant="secondary">{latestSkip.projectKey}</Badge>}
                {latestSkip.stage && <Badge variant="secondary">{stageLabel(latestSkip.stage)}</Badge>}
                {latestSkip.issueIdentifier && <Badge variant="secondary">{latestSkip.issueIdentifier}</Badge>}
                <span className="text-xs text-muted-foreground">{formatDate(latestSkip.timestamp)}</span>
              </div>
              <div>{latestSkip.message}</div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">暂无跳过记录</div>
          )}
        </CardContent>
      </Card>

      <ExecutionLog events={events} />
    </div>
  )
}

function ExecutionLog({ events }: { events: ExecutionEvent[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>执行日志</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[640px] rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>级别</TableHead>
                <TableHead>项目</TableHead>
                <TableHead>阶段</TableHead>
                <TableHead>事项</TableHead>
                <TableHead>消息</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event, index) => (
                <TableRow key={`${event.timestamp}-${event.type}-${index}`}>
                  <TableCell className="whitespace-nowrap text-xs">{formatDate(event.timestamp)}</TableCell>
                  <TableCell>
                    <EventLevelBadge level={event.level} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{event.projectKey || "-"}</TableCell>
                  <TableCell>{event.stage ? stageLabel(event.stage) : "-"}</TableCell>
                  <TableCell className="font-mono text-xs">{event.issueIdentifier || "-"}</TableCell>
                  <TableCell>
                    <div className="text-sm">{event.message}</div>
                    <div className="font-mono text-xs text-muted-foreground">{event.type}</div>
                  </TableCell>
                </TableRow>
              ))}
              {events.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    暂无执行日志
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function EventLevelBadge({ level }: { level: ExecutionEvent["level"] }) {
  if (level === "error") {
    return <Badge variant="destructive">错误</Badge>
  }
  if (level === "warn") {
    return <Badge variant="outline">警告</Badge>
  }
  return <Badge variant="secondary">信息</Badge>
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
  if (status === "canceled") {
    return (
      <Badge variant="outline">
        <StopCircle className="size-3" />
        已中止
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
  if (stage === "part3") return "阶段三"
  if (stage === "both") return "全部"
  return stage
}

function runStatusLabel(status: string) {
  if (status === "succeeded") return "成功"
  if (status === "running") return "运行中"
  if (status === "canceled") return "已中止"
  return "失败"
}

function globalRoomDescription(
  agents: CodexActivityAgent[],
  activeRuns: DaemonStatus["activeRuns"],
  lastRun?: RunSummary,
) {
  const activeText = agents.length > 0
    ? `${agents.length} 个小人正在活动`
    : activeRuns.length > 0
      ? `${activeRuns.length} 个任务启动中`
      : "当前空闲"
  const lastRunText = lastRun
    ? `最近 ${lastRun.issueIdentifier || "未知事项"} ${runStatusLabel(lastRun.status)}`
    : "暂无运行记录"
  return `单房间分区 · ${activeText} · ${lastRunText}`
}

function viewTitle(view: View, selectedProject: ProjectConfig | null) {
  if (view === "activity") return "全局 Codex 活动"
  if (view === "settings") return "设置"
  if (view === "logs") return "全局日志"
  return selectedProject?.repoName || selectedProject?.key || "项目"
}

function statusConfigLabel(key: keyof AppConfig["statuses"]) {
  const labels: Record<keyof AppConfig["statuses"], string> = {
    todo: "待处理",
    needsClarification: "需要澄清",
    blocked: "阻塞",
    ready: "可交给 Codex",
    schedule: "已排期",
    inProgress: "处理中",
    testing: "待自动复查",
    readyForReview: "待人工评审",
  }
  return labels[key]
}

function Field({
  label,
  description,
  children,
  className,
}: {
  label: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-xs text-muted-foreground">{label}</Label>
      {children}
      {description ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
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
