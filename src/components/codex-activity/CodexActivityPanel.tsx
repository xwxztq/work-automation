import { useState } from "react"
import { ChevronDown, RefreshCcw, StopCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type {
  CodexActivityAgent,
  CodexActivityKind,
  ProjectConfig,
  RunSummary,
} from "@/shared/types"

import { CodexActivityScene } from "./CodexActivityScene"

type CodexActivityPanelProps = {
  agents: CodexActivityAgent[]
  project?: ProjectConfig
  projects?: ProjectConfig[]
  lastRun?: RunSummary
  contextKey?: string
  sceneClassName?: string
  title?: string
  description?: string
  busy: boolean
  onRefresh: () => void
  onCancelRun: (id: string) => void
  onSelectRun: (id: string) => void
}

export function CodexActivityPanel({
  agents,
  project,
  projects,
  lastRun,
  contextKey,
  sceneClassName,
  title = "Codex 活动",
  description,
  busy,
  onRefresh,
  onCancelRun,
  onSelectRun,
}: CodexActivityPanelProps) {
  const [sceneVisible, setSceneVisible] = useState(true)
  const activityDescription = description ?? (
    agents.length > 0
      ? `${agents.length} 个运行中任务正在更新`
      : `${project?.repoName || project?.key || "全局活动"} 当前空闲`
  )
  const sceneContextKey = contextKey ?? project?.key ?? projects?.map((item) => item.key).join("|") ?? "activity"

  return (
    <Card className="min-w-0 shrink-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle className="min-w-0 truncate">{title}</CardTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                aria-expanded={sceneVisible}
                aria-label={sceneVisible ? "隐藏像素画面" : "显示像素画面"}
                onClick={() => setSceneVisible((visible) => !visible)}
              >
                <ChevronDown className={`size-4 transition-transform ${sceneVisible ? "" : "-rotate-90"}`} />
              </Button>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {activityDescription}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
            <RefreshCcw className="size-4" />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {sceneVisible && (
          <CodexActivityScene
            key={sceneContextKey}
            contextKey={sceneContextKey}
            agents={agents}
            lastRun={lastRun}
            projects={projects}
            className={sceneClassName}
            onSelectRun={onSelectRun}
          />
        )}
        <div className="grid max-h-[calc(3*6.5rem+2*0.5rem)] min-w-0 auto-rows-[6.5rem] grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-2 overflow-y-auto pr-1">
          {agents.map((agent) => (
            <ActivityRow
              key={agent.runId}
              agent={agent}
              busy={busy}
              onCancelRun={onCancelRun}
            />
          ))}
          {agents.length === 0 && (
            <div className="col-span-full">
              <IdleState lastRun={lastRun} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ActivityRow({
  agent,
  busy,
  onCancelRun,
}: {
  agent: CodexActivityAgent
  busy: boolean
  onCancelRun: (id: string) => void
}) {
  return (
    <div className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-lg border bg-background px-3 py-2">
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="min-w-0 truncate font-mono text-xs font-medium">{agent.issueIdentifier || "-"}</span>
          <ActivityBadge kind={agent.activityKind} label={agent.activityLabel} />
          <Badge variant="outline">{stageLabel(agent.stage)}</Badge>
        </div>
        <div className="mt-1 truncate text-sm">{agent.issueTitle || "未命名任务"}</div>
        <div className="mt-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
          {agent.detail || "等待 Codex 输出"}
        </div>
        <div className="mt-2 flex min-w-0 gap-3 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
          <span className="min-w-0 truncate">更新: {formatDate(agent.updatedAt)}</span>
          <span className="shrink-0 font-mono">PID: {processLabel(agent)}</span>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => onCancelRun(agent.runId)}
        className="w-fit self-start"
      >
        <StopCircle className="size-4" />
        停止
      </Button>
    </div>
  )
}

function IdleState({ lastRun }: { lastRun?: RunSummary }) {
  return (
    <div className="rounded-lg border border-dashed bg-background px-3 py-5 text-sm text-muted-foreground">
      <div className="font-medium text-foreground">暂无执行中的 Codex</div>
      {lastRun ? (
        <div className="mt-2 space-y-1">
          <div>
            最近运行: <span className="font-mono">{lastRun.issueIdentifier}</span>
          </div>
          <div>
            状态: <StatusText status={lastRun.status} /> · {formatDate(lastRun.updatedAt)}
          </div>
        </div>
      ) : (
        <div className="mt-2">还没有这个项目的运行记录。</div>
      )}
    </div>
  )
}

function ActivityBadge({ kind, label }: { kind: CodexActivityKind; label: string }) {
  if (kind === "failed") {
    return <Badge variant="destructive">{label}</Badge>
  }
  if (kind === "done") {
    return <Badge>{label}</Badge>
  }
  if (kind === "canceled" || kind === "waiting" || kind === "booting") {
    return <Badge variant="outline">{label}</Badge>
  }
  return <Badge variant="secondary">{label}</Badge>
}

function StatusText({ status }: { status: RunSummary["status"] }) {
  if (status === "succeeded") return <span className="text-foreground">成功</span>
  if (status === "running") return <span className="text-foreground">运行中</span>
  if (status === "canceled") return <span>已中止</span>
  return <span className="text-destructive">失败</span>
}

function processLabel(agent: CodexActivityAgent) {
  if (agent.codexPid) {
    return `${agent.pid || "-"} / ${agent.codexPid}`
  }
  return agent.pid || "-"
}

function stageLabel(stage: string) {
  if (stage === "part1") return "阶段一"
  if (stage === "split") return "拆分阶段"
  if (stage === "part2") return "阶段二"
  if (stage === "part3") return "阶段三"
  if (stage === "both") return "全部"
  return stage
}

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}
