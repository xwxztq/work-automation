import { RefreshCcw, StopCircle } from "lucide-react"

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
  project: ProjectConfig
  lastRun?: RunSummary
  busy: boolean
  onRefresh: () => void
  onCancelRun: (id: string) => void
  onSelectRun: (id: string) => void
}

export function CodexActivityPanel({
  agents,
  project,
  lastRun,
  busy,
  onRefresh,
  onCancelRun,
  onSelectRun,
}: CodexActivityPanelProps) {
  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Codex 活动</CardTitle>
            <div className="mt-1 text-xs text-muted-foreground">
              {agents.length > 0
                ? `${agents.length} 个运行中任务正在更新`
                : `${project.repoName || project.key} 当前空闲`}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
            <RefreshCcw className="size-4" />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 xl:grid-cols-[minmax(320px,0.72fr)_minmax(360px,1fr)]">
        <CodexActivityScene agents={agents} lastRun={lastRun} onSelectRun={onSelectRun} />
        <div className="min-w-0 space-y-2">
          {agents.map((agent) => (
            <ActivityRow
              key={agent.runId}
              agent={agent}
              busy={busy}
              onCancelRun={onCancelRun}
            />
          ))}
          {agents.length === 0 && <IdleState lastRun={lastRun} />}
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
    <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border bg-background px-3 py-2 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-medium">{agent.issueIdentifier || "-"}</span>
          <ActivityBadge kind={agent.activityKind} label={agent.activityLabel} />
          <Badge variant="outline">{stageLabel(agent.stage)}</Badge>
        </div>
        <div className="mt-1 truncate text-sm">{agent.issueTitle || "未命名任务"}</div>
        <div className="mt-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
          {agent.detail || "等待 Codex 输出"}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>更新: {formatDate(agent.updatedAt)}</span>
          <span className="font-mono">PID: {processLabel(agent)}</span>
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
  if (stage === "part2") return "阶段二"
  if (stage === "both") return "全部"
  return stage
}

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}
