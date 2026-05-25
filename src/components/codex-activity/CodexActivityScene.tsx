import { useEffect, useMemo, useRef } from "react"

import type {
  CodexActivityAgent,
  CodexActivityMotion,
  CodexActivityTool,
  ProjectConfig,
  RunSummary,
} from "@/shared/types"
import { cn } from "@/lib/utils"

import {
  drawCharacterFrame,
  drawColorizedFloorTile,
  drawModernOfficeSprite,
  drawOfficeAsset,
  drawWhiteCatFrame,
  loadPixelAgentAssets,
  paletteIndexFromId,
  type PixelCatAction,
  type PixelAgentAssets,
  type PixelDirection,
  type PixelFloorColor,
  type PixelSpriteRect,
} from "./pixelSprites"

const MIN_WORKSTATION_COLUMNS = 2
const MAX_WORKSTATION_COLUMNS = 5
const WORKSTATION_ROWS = 2
const WORKSTATION_COLUMN_GAP_PX = 148
const WORKSTATION_EDGE_INSET_PX = 58
const WORKSTATION_START_PADDING_PX = 6
const OFFICE_FLOOR_TILE_SIZE_PX = 32
const DEFAULT_OFFICE_LAYOUT_COLS = 21
const PROJECT_ROW_MAX_AGENTS = 5
const PROJECT_MAX_VISIBLE_AGENTS = 10
const PROJECT_ROW_INSET_X_PX = 14
const PROJECT_ROW_RIGHT_INSET_PX = 18
const PROJECT_ROW_BADGE_MIN_WIDTH_PX = 76
const PROJECT_ROW_BADGE_MAX_WIDTH_PX = 124
const PROJECT_ROW_BADGE_GAP_PX = 26
const PROJECT_ROW_BADGE_HEIGHT_PX = 24
const PROJECT_ROW_STATION_TOP_OFFSET_PX = 124
const PROJECT_ROW_STATION_BOTTOM_INSET_PX = 58
const ENTRY_FLOOR_END_RATIO = 0.18
const ENTRY_FLOOR_MIN_WIDTH_PX = 72
const WORK_AREA_MIN_WIDTH_PX = 240
const CHARACTER_SCALE = 2
const DESK_LEFT_OFFSET_PX = 24 * CHARACTER_SCALE
const CHARACTER_WIDTH = 16 * CHARACTER_SCALE
const CHARACTER_HEIGHT = 32 * CHARACTER_SCALE
const CHARACTER_SITTING_OFFSET_PX = 6 * CHARACTER_SCALE
const DESK_APPEAR_DURATION_SEC = 0.9
const REST_DURATION_SEC = 5
const WALK_SPEED_PX_PER_SEC = 48
const ARRIVAL_EPSILON_PX = 0.75
const WALK_DIRECTION_EPSILON_PX = 4
const ENTRY_QUEUE_GAP_PX = CHARACTER_WIDTH + 18
const WAITING_STAND_SIDE_OFFSET_PX = 34
const WHITE_CAT_SCALE = 1.35
const WHITE_CAT_FRAME_SIZE_PX = 50
const WHITE_CAT_SIZE_PX = Math.round(WHITE_CAT_FRAME_SIZE_PX * WHITE_CAT_SCALE)
const WHITE_CAT_SHADOW_Y_OFFSET_PX = 37 * WHITE_CAT_SCALE
const WHITE_CAT_WALK_SPEED_PX_PER_SEC = 14
const WHITE_CAT_RUN_SPEED_PX_PER_SEC = 30
const WHITE_CAT_ARRIVAL_EPSILON_PX = 1.2
const WHITE_CAT_EDGE_INSET_PX = 10
const WHITE_CAT_MIN_MOVE_DISTANCE_PX = 70
const TILE_WALL = 0
const TILE_VOID = 255
const LIGHT_CARPET_COLOR: PixelFloorColor = { h: 42, s: 22, b: 34, c: -48 }
const LIGHT_CARPET_EDGE_COLOR: PixelFloorColor = { h: 38, s: 14, b: 30, c: -82 }
const CARPET_PLAID_DARK = "rgba(124, 96, 58, 0.13)"
const CARPET_PLAID_LIGHT = "rgba(255, 248, 226, 0.18)"
const REST_AREA_MARGIN_PX = 12
const REST_AREA_MIN_WIDTH_PX = 152
const SCENE_BACKDROP = "#e7d4b8"
const WALL_FILL = "#cbb18c"
const WALL_TRIM = "#ad8d60"
const BOUNDARY_TILE_FILL = "#d9c19a"
const BOUNDARY_TILE_STROKE = "rgba(126, 91, 48, 0.22)"
const WALL_MIN_HEIGHT_PX = 52
const WALL_HEIGHT_RATIO = 0.27
const WALL_TRIM_HEIGHT_PX = 5
const WALL_FLOOR_DIVIDER_HEIGHT_PX = 2
const REST_FLOOR_START_RATIO_DESKTOP = 0.7
const REST_FLOOR_START_RATIO_COMPACT = 0.66
const WORKSTATION_FRONT_ROW_Y_RATIO = 0.72
const WORKSTATION_STACKED_FRONT_ROW_Y_RATIO = 0.82
const WORKSTATION_BACK_ROW_Y_RATIO = 0.59
const PART1_BUBBLE_TONE = "#c59a4a"
const PART2_BUBBLE_TONE = "#5f9a94"
const MODERN_DESK_LAMP_SOURCE: PixelSpriteRect = { x: 528, y: 720, width: 48, height: 72 }
const MODERN_WATER_COOLER_SOURCE: PixelSpriteRect = { x: 576, y: 736, width: 48, height: 128 }
const WALL_FURNITURE_BASE_DEPTH_PX = 28
const MODERN_WATER_COOLER_SCALE = 0.55
const WATER_COOLER_REST_AREA_OFFSET_PX = 34

type CodexActivitySceneProps = {
  contextKey: string
  agents: CodexActivityAgent[]
  lastRun?: RunSummary
  projects?: ProjectConfig[]
  className?: string
  onSelectRun: (id: string) => void
}

type SceneCharacter = {
  runId: string
  x: number
  y: number
  targetX: number
  targetY: number
  stationX: number
  stationY: number
  slot: number
  palette: number
  alpha: number
  createdAt: number
  phase: SceneCharacterPhase
  phaseStartedAt: number
  agent: CodexActivityAgent | null
  exitMotion: CodexActivityMotion
  exitTool: CodexActivityTool
  restSeat: RestSeatId | null
}

type SceneCharacterPhase = "entering" | "working" | "walkingToRest" | "resting" | "exiting"

type RestSeatId = "leftSofa" | "rightSofa" | "backSofaLeft" | "backSofaRight"

type RestSeat = {
  id: RestSeatId
  anchorX: number
  anchorY: number
  direction: PixelDirection
}

type HitRegion = {
  runId: string
  x: number
  y: number
  width: number
  height: number
}

type SceneDrawable = {
  zY: number
  draw: () => void
}

type ActivityBubble = {
  x: number
  y: number
  text: string
  stage?: string
}

type SceneWhiteCat = {
  x: number
  y: number
  targetX: number
  targetY: number
  action: PixelCatAction
  facing: "left" | "right"
  phase: "moving" | "acting"
  phaseStartedAt: number
  phaseDuration: number
  speed: number
}

type WorkstationLayout = {
  columnCount: number
  rowCount: number
  visualRowBySlotRow: Map<number, number>
}

type ProjectActivityRow = {
  label: string
  index: number
  rowIndex: number
  x: number
  y: number
  width: number
  deskStartX: number
  agentRunIds: string[]
}

type ProjectActivityRowSlot = {
  row: ProjectActivityRow
  slot: number
}

type WhiteCatActionChoice = {
  action: PixelCatAction
  minDuration: number
  maxDuration: number
}

type WhiteCatBounds = {
  left: number
  right: number
  top: number
  bottom: number
  blockedZones: WhiteCatBlockedZone[]
}

type WhiteCatBlockedZone = {
  left: number
  right: number
  top: number
  bottom: number
}

type WhiteCatPoint = {
  x: number
  y: number
}

const WHITE_CAT_ACTIONS: WhiteCatActionChoice[] = [
  { action: "idle", minDuration: 1.1, maxDuration: 2.6 },
  { action: "sitting", minDuration: 1.6, maxDuration: 3.2 },
  { action: "laying", minDuration: 2.1, maxDuration: 4.2 },
  { action: "licking1", minDuration: 1.1, maxDuration: 2.2 },
  { action: "licking2", minDuration: 1.1, maxDuration: 2.2 },
  { action: "itch", minDuration: 0.8, maxDuration: 1.4 },
  { action: "meow", minDuration: 0.7, maxDuration: 1.2 },
  { action: "stretching", minDuration: 1.2, maxDuration: 2 },
  { action: "sleeping1", minDuration: 2.4, maxDuration: 4.8 },
  { action: "sleeping2", minDuration: 2.4, maxDuration: 4.8 },
]

const WHITE_CAT_ANIMATION_SPEED: Record<PixelCatAction, number> = {
  idle: 5,
  itch: 6,
  laying: 4,
  licking1: 6,
  licking2: 6,
  meow: 6,
  run: 10,
  sitting: 1,
  sleeping1: 1,
  sleeping2: 1,
  stretching: 7,
  walk: 8,
}

export function CodexActivityScene({
  contextKey,
  agents,
  lastRun,
  projects = [],
  className,
  onSelectRun,
}: CodexActivitySceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const agentsRef = useRef<CodexActivityAgent[]>([])
  const projectsRef = useRef<ProjectConfig[]>([])
  const totalAgentsRef = useRef(0)
  const lastRunRef = useRef<RunSummary | undefined>(lastRun)
  const onSelectRunRef = useRef(onSelectRun)
  const charactersRef = useRef(new Map<string, SceneCharacter>())
  const whiteCatRef = useRef<SceneWhiteCat | null>(null)
  const hitRegionsRef = useRef<HitRegion[]>([])
  const hoveredRunIdRef = useRef<string | null>(null)
  const assetsRef = useRef<PixelAgentAssets | null>(null)

  useEffect(() => {
    charactersRef.current.clear()
    whiteCatRef.current = null
    hitRegionsRef.current = []
    hoveredRunIdRef.current = null
    if (canvasRef.current) {
      canvasRef.current.style.cursor = "default"
    }
  }, [contextKey])

  const ariaLabel = useMemo(() => {
    if (projects.length > 0) {
      return agents.length > 0
        ? `全局 Codex 活动大房间，${projects.length} 个项目，${agents.length} 个运行中任务，点击小人可查看运行详情`
        : `全局 Codex 活动大房间，${projects.length} 个项目，当前没有运行中任务`
    }
    if (agents.length === 0) {
      return lastRun
        ? `Codex 空闲，最近运行 ${lastRun.issueIdentifier} ${lastRun.status}`
        : "Codex 空闲，暂无运行记录"
    }
    return `Codex 活动场景，${agents.length} 个运行中任务，点击小人可查看运行详情`
  }, [agents.length, lastRun, projects.length])

  useEffect(() => {
    agentsRef.current = agents
    projectsRef.current = projects
    totalAgentsRef.current = agents.length
    lastRunRef.current = lastRun
  }, [agents, lastRun, projects])

  useEffect(() => {
    onSelectRunRef.current = onSelectRun
  }, [onSelectRun])

  useEffect(() => {
    let disposed = false
    loadPixelAgentAssets()
      .then((assets) => {
        if (!disposed) {
          assetsRef.current = assets
        }
      })
      .catch(() => {
        assetsRef.current = null
      })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    const canvasElement = canvasRef.current
    const containerElement = canvasElement?.parentElement
    if (!canvasElement || !containerElement) return

    const context = canvasElement.getContext("2d")
    if (!context) return

    const canvasNode: HTMLCanvasElement = canvasElement
    const containerNode: HTMLElement = containerElement
    const drawingContext: CanvasRenderingContext2D = context
    let frame = 0
    let lastFrameTime = performance.now() / 1000

    function resize() {
      const rect = containerNode.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvasNode.width = Math.max(1, Math.round(rect.width * dpr))
      canvasNode.height = Math.max(1, Math.round(rect.height * dpr))
      canvasNode.style.width = `${rect.width}px`
      canvasNode.style.height = `${rect.height}px`
    }

    function render(nowMs: number) {
      const now = nowMs / 1000
      const dt = Math.min(0.05, now - lastFrameTime)
      lastFrameTime = now

      const dpr = window.devicePixelRatio || 1
      const width = canvasNode.width / dpr
      const height = canvasNode.height / dpr
      const allAgents = agentsRef.current
      const projects = projectsRef.current
      const projectRows = projectRowsForScene(projects, allAgents, width, height)
      const visibleAgents = visibleAgentsForScene(allAgents, projectRows, width)
      const visibleAgentLimit = visibleAgents.length
      whiteCatRef.current = ensureWhiteCat(whiteCatRef.current, width, height, now)
      drawingContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawingContext.imageSmoothingEnabled = false
      drawScene({
        ctx: drawingContext,
        width,
        height,
        agents: visibleAgents,
        totalAgents: totalAgentsRef.current,
        activeRunIds: new Set(allAgents.map((agent) => agent.runId)),
        visibleAgentLimit,
        projectRows,
        lastRun: lastRunRef.current,
        characters: charactersRef.current,
        whiteCat: whiteCatRef.current,
        hitRegions: hitRegionsRef.current,
        hoveredRunId: hoveredRunIdRef.current,
        assets: assetsRef.current,
        time: now,
        dt,
      })
      frame = window.requestAnimationFrame(render)
    }

    function findHitRunId(event: MouseEvent) {
      const rect = canvasNode.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      return (
        hitRegionsRef.current.find(
          (region) =>
            x >= region.x &&
            x <= region.x + region.width &&
            y >= region.y &&
            y <= region.y + region.height,
        )?.runId || null
      )
    }

    function handleMouseMove(event: MouseEvent) {
      hoveredRunIdRef.current = findHitRunId(event)
      canvasNode.style.cursor = hoveredRunIdRef.current ? "pointer" : "default"
    }

    function handleMouseLeave() {
      hoveredRunIdRef.current = null
      canvasNode.style.cursor = "default"
    }

    function handleClick(event: MouseEvent) {
      const runId = findHitRunId(event)
      if (runId) {
        onSelectRunRef.current(runId)
      }
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(containerNode)
    canvasNode.addEventListener("mousemove", handleMouseMove)
    canvasNode.addEventListener("mouseleave", handleMouseLeave)
    canvasNode.addEventListener("click", handleClick)
    frame = window.requestAnimationFrame(render)

    return () => {
      observer.disconnect()
      canvasNode.removeEventListener("mousemove", handleMouseMove)
      canvasNode.removeEventListener("mouseleave", handleMouseLeave)
      canvasNode.removeEventListener("click", handleClick)
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div
      className={cn("h-[230px] min-w-0 overflow-hidden rounded-lg border bg-[#e7d4b8]", className)}
      aria-label={ariaLabel}
      role="img"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}

function drawScene({
  ctx,
  width,
  height,
  agents,
  totalAgents,
  activeRunIds,
  visibleAgentLimit,
  projectRows,
  lastRun,
  characters,
  whiteCat,
  hitRegions,
  hoveredRunId,
  assets,
  time,
  dt,
}: {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  agents: CodexActivityAgent[]
  totalAgents: number
  activeRunIds: Set<string>
  visibleAgentLimit: number
  projectRows: ProjectActivityRow[]
  lastRun: RunSummary | undefined
  characters: Map<string, SceneCharacter>
  whiteCat: SceneWhiteCat
  hitRegions: HitRegion[]
  hoveredRunId: string | null
  assets: PixelAgentAssets | null
  time: number
  dt: number
}) {
  ctx.clearRect(0, 0, width, height)
  drawOffice(ctx, width, height, assets, projectRows)
  syncCharacters(characters, agents, activeRunIds, lastRun, width, height, time, visibleAgentLimit, projectRows)
  updateCharacters(characters, dt, time, width)
  updateWhiteCat(whiteCat, dt, time, width, height, characters)

  hitRegions.length = 0

  const rest = restAreaPosition(width, height)
  const drawables: SceneDrawable[] = []
  queueRestAreaDrawables(drawables, ctx, rest.x, rest.y, assets)
  queueWhiteCatDrawable(drawables, ctx, whiteCat, assets, time)

  if (agents.length === 0 && characters.size === 0) {
    renderDrawables(drawables)
    return
  }

  const orderedCharacters = [...characters.values()]
  for (const character of orderedCharacters) {
    const hovered = hoveredRunId === character.runId
    const motion = renderMotion(character)
    const tool = character.agent?.activityTool || character.exitTool
    const stationX = character.stationX
    const stationY = character.stationY

    if (character.phase === "entering" || character.phase === "working") {
      queueWorkstationDrawables(
        drawables,
        ctx,
        stationX,
        stationY,
        character.phase === "working",
        hovered,
        assets,
        time,
        deskAlpha(character, time),
      )
    }
    queueCharacterDrawable(drawables, ctx, character, motion, tool, hovered, assets, time)
  }
  renderDrawables(drawables)

  for (const character of orderedCharacters) {
    const hovered = hoveredRunId === character.runId
    const motion = renderMotion(character)
    const direction = characterDirection(character, motion)
    const bubble = bubbleForCharacter(character, motion, hovered)
    if (bubble) {
      drawBubble(ctx, bubble.x, bubble.y, bubble.text, motion, hovered, bubble.stage)
    }

    const activePhase = character.phase === "entering" || character.phase === "working"
    hitRegions.push({
      runId: character.runId,
      x: activePhase
        ? Math.min(character.x - 8, character.stationX - 27 * CHARACTER_SCALE)
        : character.x - 8,
      y: activePhase
        ? Math.min(character.y - 8, character.stationY - 42 * CHARACTER_SCALE)
        : character.y - 8,
      width: activePhase ? 54 * CHARACTER_SCALE : CHARACTER_WIDTH + 16,
      height: activePhase ? 51 * CHARACTER_SCALE : CHARACTER_HEIGHT + 16,
    })

    if (hovered && character.phase !== "exiting") {
      drawHoverTarget(ctx, characterAnchorX(character), characterAnchorY(character), direction)
    }
  }

  if (totalAgents > visibleAgentLimit) {
    drawOverflowBadge(ctx, width, totalAgents - visibleAgentLimit)
  }
}

function syncCharacters(
  characters: Map<string, SceneCharacter>,
  agents: CodexActivityAgent[],
  activeRunIds: Set<string>,
  lastRun: RunSummary | undefined,
  width: number,
  height: number,
  time: number,
  visibleAgentLimit: number,
  projectRows: ProjectActivityRow[],
) {
  const activeIds = new Set(agents.map((agent) => agent.runId))
  const projectRowSlots = projectActivityRowSlotMap(projectRows)
  const occupiedWorkstationSlots = new Set<number>()

  const workstationAssignments = agents.map((agent) => {
    const existing = characters.get(agent.runId)
    const projectRowSlot = projectRowSlots.get(agent.runId)
    if (projectRowSlot) {
      return { agent, existing, slot: projectRowSlot.slot, projectRow: projectRowSlot.row }
    }

    const maxSlots = Math.max(1, visibleAgentLimit)
    let slot = existing?.slot
    if (
      slot === undefined ||
      slot >= maxSlots ||
      occupiedWorkstationSlots.has(slot)
    ) {
      slot = pickWorkstationSlot(occupiedWorkstationSlots, maxSlots)
    }
    occupiedWorkstationSlots.add(slot)
    return { agent, existing, slot, projectRow: null }
  })

  const roomSlots = workstationAssignments
    .filter((assignment) => !assignment.projectRow)
    .map(({ slot }) => slot)
  const roomLayout = workstationLayoutForSlots(roomSlots, width)

  for (const { agent, existing, slot, projectRow } of workstationAssignments) {
    const { x, y } = projectRow
      ? projectRowWorkstationPosition(slot, projectRow)
      : workstationPosition(slot, width, height, roomLayout)

    const { x: targetX, y: targetY } = workstationCharacterTarget(x, y, slot, agent.activityMotion)
    if (existing) {
      existing.targetX = targetX
      existing.targetY = targetY
      existing.stationX = x
      existing.stationY = y
      existing.slot = slot
      existing.agent = agent
      existing.restSeat = null
      if (existing.phase !== "entering" && existing.phase !== "working") {
        existing.phase = "entering"
        existing.phaseStartedAt = time
      }
      continue
    }

    characters.set(agent.runId, {
      runId: agent.runId,
      x: entryStartX(slot, projectRow),
      y: targetY,
      targetX,
      targetY,
      stationX: x,
      stationY: y,
      slot,
      palette: paletteIndexFromId(agent.runId),
      alpha: 1,
      createdAt: time,
      phase: "entering",
      phaseStartedAt: time,
      agent,
      exitMotion: "success",
      exitTool: "other",
      restSeat: null,
    })
  }

  for (const character of characters.values()) {
    if (activeIds.has(character.runId)) {
      continue
    }
    if (activeRunIds.has(character.runId)) {
      characters.delete(character.runId)
      continue
    }
    if (character.phase === "walkingToRest" || character.phase === "resting" || character.phase === "exiting") {
      continue
    }
    const rest = restAreaPosition(width, height)
    character.phase = "walkingToRest"
    character.phaseStartedAt = time
    character.agent = null
    const seat = pickRestSeat(characters, rest)
    character.restSeat = seat.id
    character.targetX = seat.anchorX - CHARACTER_WIDTH / 2
    character.targetY = restSeatTargetY(seat)
    character.exitMotion = exitMotionForRun(lastRun, character.runId)
    character.exitTool = "other"
  }
}

function updateCharacters(
  characters: Map<string, SceneCharacter>,
  dt: number,
  time: number,
  width: number,
) {
  for (const [runId, character] of characters.entries()) {
    const arrived = character.phase === "resting" ? true : moveCharacterTowardTarget(character, dt)

    if (character.phase === "entering" && arrived) {
      character.phase = "working"
      character.phaseStartedAt = time
    }

    if (character.phase === "walkingToRest" && arrived) {
      character.phase = "resting"
      character.phaseStartedAt = time
    }

    if (character.phase === "resting" && time - character.phaseStartedAt >= REST_DURATION_SEC) {
      character.phase = "exiting"
      character.phaseStartedAt = time
      character.targetX = width + CHARACTER_WIDTH + 24
      character.targetY = character.y
      character.alpha = 1
      character.restSeat = null
      continue
    }

    character.alpha = 1

    if (character.phase === "exiting" && (arrived || character.x > width + CHARACTER_WIDTH)) {
      characters.delete(runId)
    }
  }
}

function ensureWhiteCat(
  cat: SceneWhiteCat | null,
  width: number,
  height: number,
  time: number,
) {
  const bounds = whiteCatFloorBounds(width, height)
  if (!cat) {
    return createWhiteCat(bounds, time)
  }

  cat.x = clamp(cat.x, bounds.left, bounds.right)
  cat.y = clamp(cat.y, bounds.top, bounds.bottom)
  cat.targetX = clamp(cat.targetX, bounds.left, bounds.right)
  cat.targetY = clamp(cat.targetY, bounds.top, bounds.bottom)
  return cat
}

function createWhiteCat(
  bounds: WhiteCatBounds,
  time: number,
): SceneWhiteCat {
  const start = randomWhiteCatPoint(bounds)
  return {
    x: start.x,
    y: start.y,
    targetX: start.x,
    targetY: start.y,
    action: "sitting",
    facing: Math.random() < 0.5 ? "left" : "right",
    phase: "acting",
    phaseStartedAt: time,
    phaseDuration: randomRange(0.8, 1.8),
    speed: 0,
  }
}

function updateWhiteCat(
  cat: SceneWhiteCat,
  dt: number,
  time: number,
  width: number,
  height: number,
  characters: Map<string, SceneCharacter>,
) {
  const bounds = whiteCatFloorBounds(width, height, characters)
  if (cat.phase === "moving") {
    if (!isWhiteCatPathClear({ x: cat.x, y: cat.y }, { x: cat.targetX, y: cat.targetY }, bounds)) {
      startWhiteCatMove(cat, bounds, time)
      return
    }
    const arrived = moveWhiteCatTowardTarget(cat, dt)
    if (arrived) {
      startRandomWhiteCatAction(cat, time)
    }
    return
  }

  if (time - cat.phaseStartedAt >= cat.phaseDuration || !isWhiteCatPointClear(cat, bounds)) {
    startWhiteCatMove(cat, bounds, time)
  }
}

function moveWhiteCatTowardTarget(cat: SceneWhiteCat, dt: number) {
  const dx = cat.targetX - cat.x
  const dy = cat.targetY - cat.y
  const distance = Math.hypot(dx, dy)
  if (distance <= WHITE_CAT_ARRIVAL_EPSILON_PX) {
    cat.x = cat.targetX
    cat.y = cat.targetY
    return true
  }

  if (Math.abs(dx) > 2) {
    cat.facing = dx > 0 ? "right" : "left"
  }

  const step = cat.speed * dt
  if (step >= distance) {
    cat.x = cat.targetX
    cat.y = cat.targetY
    return true
  }

  cat.x += (dx / distance) * step
  cat.y += (dy / distance) * step
  return false
}

function startWhiteCatMove(
  cat: SceneWhiteCat,
  bounds: WhiteCatBounds,
  time: number,
) {
  let target = randomWhiteCatPoint(bounds)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (
      Math.hypot(target.x - cat.x, target.y - cat.y) >= WHITE_CAT_MIN_MOVE_DISTANCE_PX &&
      isWhiteCatPathClear({ x: cat.x, y: cat.y }, target, bounds)
    ) {
      break
    }
    target = randomWhiteCatPoint(bounds)
  }

  const running = Math.random() < 0.18
  cat.targetX = target.x
  cat.targetY = target.y
  cat.action = running ? "run" : "walk"
  cat.speed = running ? WHITE_CAT_RUN_SPEED_PX_PER_SEC : WHITE_CAT_WALK_SPEED_PX_PER_SEC
  cat.phase = "moving"
  cat.phaseStartedAt = time
  cat.phaseDuration = 0
  if (Math.abs(cat.targetX - cat.x) > 2) {
    cat.facing = cat.targetX > cat.x ? "right" : "left"
  }
}

function startRandomWhiteCatAction(cat: SceneWhiteCat, time: number) {
  const choice = WHITE_CAT_ACTIONS[Math.floor(Math.random() * WHITE_CAT_ACTIONS.length)]
  cat.action = choice.action
  cat.phase = "acting"
  cat.phaseStartedAt = time
  cat.phaseDuration = randomRange(choice.minDuration, choice.maxDuration)
  cat.speed = 0
}

function whiteCatFloorBounds(
  width: number,
  height: number,
  characters?: Map<string, SceneCharacter>,
): WhiteCatBounds {
  const wallHeight = Math.max(WALL_MIN_HEIGHT_PX, height * WALL_HEIGHT_RATIO)
  return {
    left: WHITE_CAT_EDGE_INSET_PX,
    right: width - WHITE_CAT_SIZE_PX - WHITE_CAT_EDGE_INSET_PX,
    top: wallHeight + 6,
    bottom: height - WHITE_CAT_SIZE_PX - 6,
    blockedZones: whiteCatWorkstationBlockedZones(characters),
  }
}

function whiteCatWorkstationBlockedZones(characters: Map<string, SceneCharacter> | undefined) {
  if (!characters) {
    return []
  }
  const scale = CHARACTER_SCALE
  const zones: WhiteCatBlockedZone[] = []
  for (const character of characters.values()) {
    if (character.phase !== "entering" && character.phase !== "working") {
      continue
    }
    zones.push({
      left: character.stationX - 34 * scale,
      right: character.stationX + 34 * scale,
      top: character.stationY - 34 * scale,
      bottom: character.stationY + 16 * scale,
    })
  }
  return zones
}

function randomWhiteCatPoint(bounds: WhiteCatBounds) {
  let point = randomWhiteCatPointInBounds(bounds)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (isWhiteCatPointClear(point, bounds)) {
      return point
    }
    point = randomWhiteCatPointInBounds(bounds)
  }
  return point
}

function randomWhiteCatPointInBounds(bounds: WhiteCatBounds) {
  return { x: randomRange(bounds.left, bounds.right), y: randomRange(bounds.top, bounds.bottom) }
}

function isWhiteCatPointClear(point: WhiteCatPoint, bounds: WhiteCatBounds) {
  return !whiteCatBlockedZoneAt(point, bounds.blockedZones)
}

function isWhiteCatPathClear(from: WhiteCatPoint, to: WhiteCatPoint, bounds: WhiteCatBounds) {
  if (!isWhiteCatPointClear(to, bounds)) {
    return false
  }
  const startZone = whiteCatBlockedZoneAt(from, bounds.blockedZones)
  let leftStartZone = !startZone
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const steps = Math.max(8, Math.ceil(distance / 16))
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    const point = {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    }
    const zone = whiteCatBlockedZoneAt(point, bounds.blockedZones)
    if (!zone) {
      leftStartZone = true
      continue
    }
    if (zone !== startZone || leftStartZone) {
      return false
    }
  }
  return true
}

function whiteCatBlockedZoneAt(point: WhiteCatPoint, zones: WhiteCatBlockedZone[]) {
  const foot = whiteCatFootPoint(point)
  return zones.find(
    (zone) =>
      foot.x >= zone.left &&
      foot.x <= zone.right &&
      foot.y >= zone.top &&
      foot.y <= zone.bottom,
  )
}

function whiteCatFootPoint(point: WhiteCatPoint) {
  return {
    x: point.x + WHITE_CAT_SIZE_PX / 2,
    y: point.y + WHITE_CAT_SHADOW_Y_OFFSET_PX,
  }
}

function randomRange(min: number, max: number) {
  if (max < min) {
    return (min + max) / 2
  }
  return min + Math.random() * (max - min)
}

function moveCharacterTowardTarget(character: SceneCharacter, dt: number) {
  const dx = character.targetX - character.x
  const dy = character.targetY - character.y
  const distance = Math.hypot(dx, dy)
  if (distance <= ARRIVAL_EPSILON_PX) {
    character.x = character.targetX
    character.y = character.targetY
    return true
  }

  const step = WALK_SPEED_PX_PER_SEC * dt
  if (step >= distance) {
    character.x = character.targetX
    character.y = character.targetY
    return true
  }

  character.x += (dx / distance) * step
  character.y += (dy / distance) * step
  return false
}

function pickWorkstationSlot(occupiedSlots: Set<number>, maxSlots: number) {
  for (let slot = 0; slot < maxSlots; slot += 1) {
    if (!occupiedSlots.has(slot)) {
      return slot
    }
  }
  return 0
}

function visibleAgentsForScene(
  agents: CodexActivityAgent[],
  projectRows: ProjectActivityRow[],
  width: number,
) {
  if (projectRows.length === 0) {
    return agents.slice(0, visibleAgentLimitForWidth(width))
  }

  const agentByRunId = new Map(agents.map((agent) => [agent.runId, agent]))
  return projectRows.flatMap((row) =>
    row.agentRunIds
      .map((runId) => agentByRunId.get(runId))
      .filter((agent): agent is CodexActivityAgent => Boolean(agent)),
  )
}

function projectRowsForScene(
  projects: ProjectConfig[],
  agents: CodexActivityAgent[],
  width: number,
  height: number,
): ProjectActivityRow[] {
  if (projects.length === 0 || agents.length === 0) {
    return []
  }

  const projectKeys = new Set(projects.map((project) => project.key))
  const rowDrafts: Array<{
    label: string
    rowIndex: number
    agentRunIds: string[]
  }> = []

  for (const project of projects) {
    const projectAgents = agents
      .filter((agent) => agent.projectKey === project.key)
      .slice(0, PROJECT_MAX_VISIBLE_AGENTS)
    for (let rowIndex = 0; rowIndex * PROJECT_ROW_MAX_AGENTS < projectAgents.length; rowIndex += 1) {
      rowDrafts.push({
        label: projectLabel(project),
        rowIndex,
        agentRunIds: projectAgents
          .slice(rowIndex * PROJECT_ROW_MAX_AGENTS, (rowIndex + 1) * PROJECT_ROW_MAX_AGENTS)
          .map((agent) => agent.runId),
      })
    }
  }

  const unknownProjectAgents = agents
    .filter((agent) => !projectKeys.has(agent.projectKey))
    .slice(0, PROJECT_MAX_VISIBLE_AGENTS)
  for (let rowIndex = 0; rowIndex * PROJECT_ROW_MAX_AGENTS < unknownProjectAgents.length; rowIndex += 1) {
    rowDrafts.push({
      label: "未配置项目",
      rowIndex,
      agentRunIds: unknownProjectAgents
        .slice(rowIndex * PROJECT_ROW_MAX_AGENTS, (rowIndex + 1) * PROJECT_ROW_MAX_AGENTS)
        .map((agent) => agent.runId),
    })
  }

  const wallHeight = Math.max(WALL_MIN_HEIGHT_PX, height * WALL_HEIGHT_RATIO)
  const left = PROJECT_ROW_INSET_X_PX
  const right = clamp(
    workAreaRight(width) - PROJECT_ROW_RIGHT_INSET_PX,
    left + PROJECT_ROW_BADGE_MIN_WIDTH_PX + PROJECT_ROW_BADGE_GAP_PX + 80,
    width - PROJECT_ROW_RIGHT_INSET_PX,
  )
  const rowWidth = Math.max(1, right - left)
  const topY = Math.min(
    wallHeight + PROJECT_ROW_STATION_TOP_OFFSET_PX,
    Math.max(wallHeight + 76, height - PROJECT_ROW_STATION_BOTTOM_INSET_PX),
  )
  const bottomY = Math.max(topY, height - PROJECT_ROW_STATION_BOTTOM_INSET_PX)
  const yStep = rowDrafts.length <= 1 ? 0 : (bottomY - topY) / (rowDrafts.length - 1)

  return rowDrafts.map((draft, index) => ({
    ...draft,
    index,
    x: left,
    y: rowDrafts.length <= 1 ? clamp(height * 0.68, topY, bottomY) : topY + yStep * index,
    width: rowWidth,
    deskStartX: workstationStartDeskLeft(width),
  }))
}

function projectActivityRowSlotMap(projectRows: ProjectActivityRow[]) {
  const rowSlots = new Map<string, ProjectActivityRowSlot>()
  for (const row of projectRows) {
    row.agentRunIds.forEach((runId, rowSlot) => {
      rowSlots.set(runId, {
        row,
        slot: row.rowIndex * PROJECT_ROW_MAX_AGENTS + rowSlot,
      })
    })
  }
  return rowSlots
}

function workstationLayoutForSlots(slots: number[], width: number): WorkstationLayout {
  const columnCount = workstationColumnCount(width)
  const slotRows = [
    ...new Set(slots.map((slot) => workstationRowForSlot(slot, columnCount))),
  ].sort((a, b) => a - b)
  const visualRowBySlotRow = new Map<number, number>()
  slotRows.forEach((row, index) => {
    visualRowBySlotRow.set(row, index)
  })
  return { columnCount, rowCount: slotRows.length, visualRowBySlotRow }
}

function workstationPosition(
  slot: number,
  width: number,
  height: number,
  layout: WorkstationLayout,
) {
  const workArea = workstationArea(width)
  const column = slot % layout.columnCount
  const slotRow = workstationRowForSlot(slot, layout.columnCount)
  const visualRow = layout.visualRowBySlotRow.get(slotRow) ?? 0
  const slotLeft = stationXForDeskLeft(workstationStartDeskLeft(width))
  const slotRight = Math.max(slotLeft, workArea.right - WORKSTATION_EDGE_INSET_PX)
  const usableWidth = Math.max(1, slotRight - slotLeft)
  const columnProgress = layout.columnCount <= 1 ? 0.5 : column / (layout.columnCount - 1)
  const x = slotLeft + usableWidth * columnProgress
  const y = height * workstationRowYRatio(visualRow, layout.rowCount)
  return { x, y }
}

function projectRowWorkstationPosition(slot: number, row: ProjectActivityRow) {
  const rowSlot = slot % PROJECT_ROW_MAX_AGENTS
  const firstDeskLeft = Math.max(
    row.deskStartX,
    row.x + PROJECT_ROW_BADGE_MIN_WIDTH_PX + PROJECT_ROW_BADGE_GAP_PX,
  )
  const slotLeft = stationXForDeskLeft(firstDeskLeft)
  const slotRight = Math.max(slotLeft, row.x + row.width - PROJECT_ROW_RIGHT_INSET_PX - DESK_LEFT_OFFSET_PX)
  const usableWidth = Math.max(1, slotRight - slotLeft)
  const columnProgress = PROJECT_ROW_MAX_AGENTS <= 1 ? 0.5 : rowSlot / (PROJECT_ROW_MAX_AGENTS - 1)
  const x = slotLeft + usableWidth * columnProgress
  const y = row.y
  return { x, y }
}

function workstationRowForSlot(slot: number, columnCount: number) {
  return Math.floor(slot / columnCount)
}

function workstationRowYRatio(visualRow: number, rowCount: number) {
  if (rowCount <= 1) {
    return WORKSTATION_FRONT_ROW_Y_RATIO
  }
  if (rowCount === 2) {
    return visualRow === 0 ? WORKSTATION_STACKED_FRONT_ROW_Y_RATIO : WORKSTATION_BACK_ROW_Y_RATIO
  }
  const progress = visualRow / Math.max(1, rowCount - 1)
  return WORKSTATION_STACKED_FRONT_ROW_Y_RATIO +
    (WORKSTATION_BACK_ROW_Y_RATIO - WORKSTATION_STACKED_FRONT_ROW_Y_RATIO) * progress
}

function workstationCharacterTarget(
  stationX: number,
  stationY: number,
  slot: number,
  motion: CodexActivityMotion,
) {
  const sideOffset = motion === "waiting" ? waitingStandSideOffset(slot) : 0
  return {
    x: stationX + sideOffset - CHARACTER_WIDTH / 2,
    y: stationY - CHARACTER_HEIGHT + 12,
  }
}

function waitingStandSideOffset(slot: number) {
  return slot % 2 === 0 ? -WAITING_STAND_SIDE_OFFSET_PX : WAITING_STAND_SIDE_OFFSET_PX
}

function waitingStandDirection(slot: number): PixelDirection {
  return slot % 2 === 0 ? "right" : "left"
}

function entryStartX(slot: number, row?: ProjectActivityRow | null) {
  if (row) {
    return row.x - CHARACTER_WIDTH - (slot % PROJECT_ROW_MAX_AGENTS) * 16
  }
  return -CHARACTER_WIDTH - slot * ENTRY_QUEUE_GAP_PX
}

function renderMotion(character: SceneCharacter): CodexActivityMotion {
  if (character.phase === "entering" || character.phase === "walkingToRest" || character.phase === "exiting") {
    return "walking"
  }
  if (character.phase === "resting") {
    return "idle"
  }
  if (Math.abs(character.targetX - character.x) > 4 || Math.abs(character.targetY - character.y) > 4) {
    return "walking"
  }
  return character.agent?.activityMotion || "waiting"
}

function characterDirection(character: SceneCharacter, motion: CodexActivityMotion): PixelDirection {
  if (character.phase === "resting") {
    return character.restSeat ? restSeatDirection(character.restSeat) : "up"
  }
  if (motion === "walking") {
    return walkingDirection(character)
  }
  if (character.phase === "working" && motion === "waiting") {
    return waitingStandDirection(character.slot)
  }
  if (motion === "typing" || motion === "reading" || motion === "running") {
    return "up"
  }
  return "down"
}

function walkingDirection(character: SceneCharacter): PixelDirection {
  const dx = character.targetX - character.x
  const dy = character.targetY - character.y
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)

  if (absX <= WALK_DIRECTION_EPSILON_PX && absY <= WALK_DIRECTION_EPSILON_PX) {
    return destinationDirection(character)
  }
  if (absX >= absY && absX > WALK_DIRECTION_EPSILON_PX) {
    return dx > 0 ? "right" : "left"
  }
  if (absY > WALK_DIRECTION_EPSILON_PX) {
    return dy > 0 ? "down" : "up"
  }
  return destinationDirection(character)
}

function destinationDirection(character: SceneCharacter): PixelDirection {
  if (character.phase === "walkingToRest" && character.restSeat) {
    return restSeatDirection(character.restSeat)
  }
  if (character.phase === "entering" || character.phase === "working") {
    return "up"
  }
  if (character.phase === "exiting") {
    return "right"
  }
  return "down"
}

function deskAlpha(character: SceneCharacter, time: number) {
  if (character.phase === "working") return 1
  if (character.phase !== "entering") return 0
  return Math.min(1, (time - character.createdAt) / DESK_APPEAR_DURATION_SEC)
}

function characterAnchorX(character: SceneCharacter) {
  return character.x + CHARACTER_WIDTH / 2
}

function characterAnchorY(character: SceneCharacter) {
  return character.y + CHARACTER_HEIGHT - 12
}

function bubbleForCharacter(
  character: SceneCharacter,
  motion: CodexActivityMotion,
  hovered: boolean,
): ActivityBubble | null {
  if (character.phase === "exiting") return null
  if (character.phase === "entering" || character.phase === "working") {
    return {
      x: character.stationX,
      y: character.stationY - 124,
      text: hovered
        ? hoveredBubbleText(character)
        : activityGlyph(character.agent?.activityKind, motion),
      stage: character.agent?.stage,
    }
  }
  return {
    x: characterAnchorX(character),
    y: character.y - 28,
    text: character.exitMotion === "failure" ? "ERR" : "OK",
  }
}

function drawOffice(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  assets: PixelAgentAssets | null,
  projectRows: ProjectActivityRow[],
) {
  ctx.fillStyle = SCENE_BACKDROP
  ctx.fillRect(0, 0, width, height)

  const wallHeight = Math.max(WALL_MIN_HEIGHT_PX, height * WALL_HEIGHT_RATIO)
  ctx.fillStyle = WALL_FILL
  ctx.fillRect(0, 0, width, wallHeight)
  ctx.fillStyle = WALL_TRIM
  ctx.fillRect(0, wallHeight - WALL_TRIM_HEIGHT_PX, width, WALL_TRIM_HEIGHT_PX)

  const tileSize = OFFICE_FLOOR_TILE_SIZE_PX
  if (!drawPixelAgentsOfficeFloor(ctx, width, height, wallHeight, tileSize, assets)) {
    for (let y = wallHeight; y < height; y += tileSize) {
      for (let x = 0; x < width; x += tileSize) {
        drawOfficeTile(ctx, x, y, tileSize, x < workAreaRight(width) ? "wood" : "stone")
      }
    }
  }

  ctx.fillStyle = "rgba(126, 91, 48, 0.14)"
  ctx.fillRect(0, wallHeight, width, WALL_FLOOR_DIVIDER_HEIGHT_PX)
  ctx.fillStyle = "rgba(180, 154, 112, 0.12)"
  ctx.fillRect(0, height - 2, width, 2)

  const decorScale = 1.8
  const workArea = workstationArea(width)
  const bookshelfX = clamp(workArea.left + 10, workArea.left, Math.max(workArea.left, workArea.right - 118))
  drawOfficeAsset(ctx, assets, { key: "bookshelf", x: bookshelfX, y: wallHeight - 58, scale: decorScale })
  drawOfficeAsset(ctx, assets, { key: "bookshelf", x: bookshelfX + 60, y: wallHeight - 58, scale: decorScale })
  drawOfficeAsset(ctx, assets, { key: "whiteboard", x: width - 100, y: wallHeight - 62, scale: decorScale })
  drawOfficeAsset(ctx, assets, { key: "clock", x: width * 0.52 + 2, y: 5, scale: 1.7, scaleX: 1.4 })
  drawOfficeAsset(ctx, assets, { key: "plant", x: width - 40, y: wallHeight + 4, scale: 1.7 })
  drawOfficeAsset(ctx, assets, { key: "plant", x: 5, y: height - 82, scale: 1.7 })
  drawOfficeAsset(ctx, assets, { key: "smallPainting", x: width - 156, y: wallHeight - 62, scale: 1.6 })
  const restLeft = workAreaRight(width)
  const waterCoolerWidth = MODERN_WATER_COOLER_SOURCE.width * MODERN_WATER_COOLER_SCALE
  const waterCoolerX = clamp(
    restLeft + WATER_COOLER_REST_AREA_OFFSET_PX,
    restLeft + REST_AREA_MARGIN_PX,
    width - waterCoolerWidth - REST_AREA_MARGIN_PX,
  )
  const wallFurnitureBaseY = wallHeight + WALL_FURNITURE_BASE_DEPTH_PX
  const waterCoolerY = wallSpriteY(wallFurnitureBaseY, MODERN_WATER_COOLER_SOURCE, MODERN_WATER_COOLER_SCALE)
  drawModernOfficeSprite(ctx, assets, {
    source: MODERN_WATER_COOLER_SOURCE,
    x: waterCoolerX,
    y: waterCoolerY,
    scale: MODERN_WATER_COOLER_SCALE,
  })

  if (projectRows.length > 0) {
    drawProjectRowBadges(ctx, projectRows)
  }
}

function drawProjectRowBadges(ctx: CanvasRenderingContext2D, rows: ProjectActivityRow[]) {
  for (const row of rows) {
    const labelX = Math.round(row.x)
    const labelY = Math.round(row.y - 52)
    const badgeWidth = projectRowBadgeWidth(row.width)

    ctx.font = "600 11px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    const measuredWidth = Math.min(badgeWidth, Math.ceil(ctx.measureText(row.label).width) + 18)
    ctx.fillStyle = "rgba(251, 248, 239, 0.94)"
    ctx.fillRect(labelX, labelY, measuredWidth, PROJECT_ROW_BADGE_HEIGHT_PX)
    ctx.strokeStyle = "rgba(115, 86, 46, 0.72)"
    ctx.lineWidth = 1
    ctx.strokeRect(labelX + 0.5, labelY + 0.5, measuredWidth - 1, PROJECT_ROW_BADGE_HEIGHT_PX - 1)

    ctx.fillStyle = "#3f382f"
    ctx.textBaseline = "middle"
    ctx.fillText(row.label, labelX + 9, labelY + PROJECT_ROW_BADGE_HEIGHT_PX / 2, measuredWidth - 16)
    ctx.textBaseline = "alphabetic"
  }
}

function projectLabel(project: ProjectConfig) {
  return project.repoName || project.key
}

function projectRowBadgeWidth(width: number) {
  return clamp(width * 0.2, PROJECT_ROW_BADGE_MIN_WIDTH_PX, PROJECT_ROW_BADGE_MAX_WIDTH_PX)
}

function drawPixelAgentsOfficeFloor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  wallHeight: number,
  tileSize: number,
  assets: PixelAgentAssets | null,
) {
  const layout = assets?.layout
  if (!layout?.tileColors) {
    return false
  }

  const floorRows = drawableFloorRows(layout.tiles, layout.cols, layout.rows)
  if (!floorRows) {
    return false
  }

  const floorHeight = Math.max(1, height - wallHeight)
  for (let y = wallHeight; y < height; y += tileSize) {
    const row = sampleLayoutRow(y - wallHeight, floorHeight, floorRows.first, floorRows.last)
    for (let x = 0; x < width; x += tileSize) {
      const col = sampleLayoutCol(x, width, layout.cols)
      const index = row * layout.cols + col
      const tile = activityTileAt(layout.tiles, layout.cols, row, col)

      if (tile === TILE_VOID) {
        drawLayoutBoundaryTile(ctx, x, y, tileSize)
        continue
      }
      if (tile === TILE_WALL) {
        drawLayoutBoundaryTile(ctx, x, y, tileSize)
        continue
      }
      const floorTile = activityFloorTile(tile)
      const floorColor = activityFloorColor(tile, layout.tileColors[index])
      if (!drawColorizedFloorTile(ctx, assets, floorTile, floorColor, x, y, tileSize)) {
        return false
      }
      if (isLightCarpetTile(tile)) {
        drawCarpetPlaid(ctx, x, y, tileSize)
      }
    }
  }

  return true
}

function activityTileAt(tiles: number[], cols: number, row: number, col: number) {
  const index = row * cols + col
  const tile = tiles[index]
  if (tile === TILE_WALL && isInternalAreaDivider(tiles, cols, row, col)) {
    return tiles[row * cols + col + 1]
  }
  return tile
}

function isInternalAreaDivider(tiles: number[], cols: number, row: number, col: number) {
  if (col <= 0 || col >= cols - 1) {
    return false
  }
  return isFloorTile(tiles[row * cols + col - 1]) && isFloorTile(tiles[row * cols + col + 1])
}

function isFloorTile(tile: number) {
  return tile !== TILE_WALL && tile !== TILE_VOID
}

function activityFloorTile(tile: number) {
  return tile === 9 ? 1 : tile
}

function activityFloorColor(tile: number, color: PixelFloorColor | null | undefined) {
  if (tile === 1) {
    return LIGHT_CARPET_COLOR
  }
  if (tile === 9) {
    return LIGHT_CARPET_EDGE_COLOR
  }
  return color
}

function isLightCarpetTile(tile: number) {
  return tile === 1 || tile === 9
}

function drawCarpetPlaid(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const left = Math.round(x)
  const top = Math.round(y)
  const midX = Math.round(x + size / 2)
  const midY = Math.round(y + size / 2)

  ctx.fillStyle = CARPET_PLAID_DARK
  ctx.fillRect(midX, top, 1, size)
  ctx.fillRect(left, midY, size, 1)

  ctx.fillStyle = CARPET_PLAID_LIGHT
  ctx.fillRect(midX + 1, top, 1, size)
  ctx.fillRect(left, midY + 1, size, 1)
}

function drawableFloorRows(tiles: number[], cols: number, rows: number) {
  let first = -1
  let last = -1
  for (let row = 0; row < rows; row += 1) {
    const hasFloor = tiles
      .slice(row * cols, row * cols + cols)
      .some((tile) => tile !== TILE_VOID && tile !== TILE_WALL)
    if (!hasFloor) {
      continue
    }
    if (first === -1) {
      first = row
    }
    last = row
  }
  return first === -1 ? null : { first, last }
}

function sampleLayoutRow(y: number, floorHeight: number, first: number, last: number) {
  const rowCount = last - first + 1
  const ratio = Math.min(0.999, Math.max(0, y / floorHeight))
  return first + Math.min(rowCount - 1, Math.floor(ratio * rowCount))
}

function sampleLayoutCol(x: number, width: number, cols: number) {
  const sampledCols = Math.max(1, cols - 1)
  const restStartCol = Math.min(sampledCols - 1, Math.max(1, Math.floor(sampledCols / 2)))
  const restStartX = clamp(workAreaRight(width), 1, Math.max(1, width - 1))

  if (x < restStartX) {
    const ratio = Math.min(0.999, Math.max(0, x / restStartX))
    return Math.min(restStartCol - 1, Math.floor(ratio * restStartCol))
  }

  const restWidth = Math.max(1, width - restStartX)
  const restCols = Math.max(1, sampledCols - restStartCol)
  const ratio = Math.min(0.999, Math.max(0, (x - restStartX) / restWidth))
  return restStartCol + Math.min(restCols - 1, Math.floor(ratio * restCols))
}

function drawLayoutBoundaryTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) {
  ctx.fillStyle = BOUNDARY_TILE_FILL
  ctx.fillRect(Math.round(x), Math.round(y), size, size)
  ctx.strokeStyle = BOUNDARY_TILE_STROKE
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, size, size)
  drawCarpetPlaid(ctx, x, y, size)
}

function drawOfficeTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  kind: "wood" | "stone",
) {
  ctx.fillStyle = kind === "wood" ? "#9a6637" : "#ddd5cb"
  ctx.fillRect(Math.round(x), Math.round(y), size, size)
  ctx.strokeStyle = kind === "wood" ? "#80512c" : "#c7bfb5"
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, size, size)
  if (kind === "wood") {
    ctx.fillStyle = "rgba(83, 49, 26, 0.22)"
    ctx.fillRect(Math.round(x + 7), Math.round(y + 7), 3, 3)
    ctx.fillRect(Math.round(x + size - 11), Math.round(y + 17), 3, 3)
    return
  }
  ctx.fillStyle = "rgba(158, 149, 139, 0.22)"
  ctx.fillRect(Math.round(x + size / 2 - 2), Math.round(y + size / 2 - 2), 4, 4)
}

function restAreaPosition(width: number, height: number) {
  const scale = CHARACTER_SCALE
  const groupHalfWidth = 32 * scale
  const restLeft = workAreaRight(width)
  const centeredX = restLeft + (width - restLeft) / 2
  const x = clamp(centeredX, groupHalfWidth + REST_AREA_MARGIN_PX, width - groupHalfWidth - REST_AREA_MARGIN_PX)
  const y = height * 0.48
  return { x, y }
}

function restSeats(rest: ReturnType<typeof restAreaPosition>): RestSeat[] {
  const scale = CHARACTER_SCALE
  return [
    {
      id: "leftSofa",
      anchorX: rest.x - 20 * scale,
      anchorY: rest.y + 24 * scale,
      direction: "right",
    },
    {
      id: "rightSofa",
      anchorX: rest.x + 20 * scale,
      anchorY: rest.y + 24 * scale,
      direction: "left",
    },
    {
      id: "backSofaLeft",
      anchorX: rest.x - 8 * scale,
      anchorY: rest.y + 40 * scale,
      direction: "up",
    },
    {
      id: "backSofaRight",
      anchorX: rest.x + 8 * scale,
      anchorY: rest.y + 40 * scale,
      direction: "up",
    },
  ]
}

function pickRestSeat(characters: Map<string, SceneCharacter>, rest: ReturnType<typeof restAreaPosition>) {
  const occupiedSeats = new Set<RestSeatId>()
  for (const character of characters.values()) {
    if (
      character.restSeat &&
      (character.phase === "walkingToRest" || character.phase === "resting")
    ) {
      occupiedSeats.add(character.restSeat)
    }
  }

  const seats = restSeats(rest)
  return seats.find((seat) => !occupiedSeats.has(seat.id)) || seats[0]
}

function restSeatTargetY(seat: RestSeat) {
  return seat.anchorY - CHARACTER_HEIGHT + CHARACTER_SITTING_OFFSET_PX
}

function restSeatDirection(seatId: RestSeatId): PixelDirection {
  if (seatId === "leftSofa") return "right"
  if (seatId === "rightSofa") return "left"
  return "up"
}

function visibleAgentLimitForWidth(width: number) {
  return workstationColumnCount(width) * WORKSTATION_ROWS
}

function workstationColumnCount(width: number) {
  const workArea = workstationArea(width)
  const safeWidth = Math.max(0, workArea.width - WORKSTATION_EDGE_INSET_PX * 2)
  const fittedColumns = Math.floor(safeWidth / WORKSTATION_COLUMN_GAP_PX) + 1
  return Math.max(
    MIN_WORKSTATION_COLUMNS,
    Math.min(MAX_WORKSTATION_COLUMNS, fittedColumns),
  )
}

function workstationArea(width: number) {
  const right = workAreaRight(width)
  const preferredLeft = Math.max(ENTRY_FLOOR_MIN_WIDTH_PX, width * ENTRY_FLOOR_END_RATIO)
  const left = Math.min(preferredLeft, Math.max(28, right - WORK_AREA_MIN_WIDTH_PX))
  return {
    left,
    right,
    width: Math.max(1, right - left),
  }
}

function workstationStartDeskLeft(width: number) {
  const sampledCols = Math.max(1, DEFAULT_OFFICE_LAYOUT_COLS - 1)
  const restStartCol = Math.min(sampledCols - 1, Math.max(1, Math.floor(sampledCols / 2)))
  const firstFloorColStartX = workAreaRight(width) / restStartCol
  return Math.ceil(firstFloorColStartX / OFFICE_FLOOR_TILE_SIZE_PX) * OFFICE_FLOOR_TILE_SIZE_PX +
    WORKSTATION_START_PADDING_PX
}

function stationXForDeskLeft(deskLeft: number) {
  return deskLeft + DESK_LEFT_OFFSET_PX
}

function workAreaRight(width: number) {
  const preferred = width * (width >= 520 ? REST_FLOOR_START_RATIO_DESKTOP : REST_FLOOR_START_RATIO_COMPACT)
  return Math.min(preferred, Math.max(1, width - REST_AREA_MIN_WIDTH_PX))
}

function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return (min + max) / 2
  }
  return Math.min(max, Math.max(min, value))
}

function wallSpriteY(baseY: number, source: PixelSpriteRect, scale: number) {
  return baseY - source.height * scale
}

function queueRestAreaDrawables(
  drawables: SceneDrawable[],
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  assets: PixelAgentAssets | null,
) {
  const scale = CHARACTER_SCALE
  const tableX = x - 16 * scale
  const tableY = y
  drawables.push({
    zY: tableY,
    draw: () => {
      const rendered = drawOfficeAsset(ctx, assets, {
        key: "sofaFront",
        x: tableX,
        y: tableY - 16 * scale,
        scale,
      })
      if (!rendered) {
        drawFallbackSofa(ctx, tableX, tableY - 16 * scale, "front")
      }
    },
  })
  drawables.push({
    zY: tableY + 32 * scale,
    draw: () => {
      const rendered = drawOfficeAsset(ctx, assets, {
        key: "coffeeTable",
        x: tableX,
        y: tableY,
        scale,
      })
      if (!rendered) {
        drawFallbackTable(ctx, tableX, tableY)
      }
      drawOfficeAsset(ctx, assets, {
        key: "coffee",
        x: tableX + 11 * scale,
        y: tableY + 9 * scale,
        scale,
      })
    },
  })
  drawables.push({
    zY: tableY + 32 * scale,
    draw: () => {
      const rendered = drawOfficeAsset(ctx, assets, {
        key: "sofaSide",
        x: tableX - 16 * scale,
        y: tableY,
        scale,
      })
      if (!rendered) {
        drawFallbackSideSofa(ctx, tableX - 16 * scale, tableY)
      }
    },
  })
  drawables.push({
    zY: tableY + 32 * scale,
    draw: () => {
      const rendered = drawOfficeAsset(ctx, assets, {
        key: "sofaSide",
        x: tableX + 32 * scale,
        y: tableY,
        scale,
        flipX: true,
      })
      if (!rendered) {
        drawFallbackSideSofa(ctx, tableX + 32 * scale, tableY)
      }
    },
  })
  drawables.push({
    zY: tableY + 48 * scale + 1,
    draw: () => {
      const rendered = drawOfficeAsset(ctx, assets, {
        key: "sofaBack",
        x: tableX,
        y: tableY + 32 * scale,
        scale,
      })
      if (!rendered) {
        drawFallbackSofa(ctx, tableX, tableY + 32 * scale, "back")
      }
    },
  })
}

function drawFallbackSofa(ctx: CanvasRenderingContext2D, x: number, y: number, side: "back" | "front") {
  ctx.fillStyle = side === "back" ? "#8b5f73" : "#a46d81"
  ctx.fillRect(Math.round(x), Math.round(y), 64, 28)
  ctx.fillStyle = "#6d4358"
  ctx.fillRect(Math.round(x), Math.round(y + 22), 64, 6)
}

function drawFallbackSideSofa(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = "#8b5f73"
  ctx.fillRect(Math.round(x), Math.round(y), 32, 64)
  ctx.fillStyle = "#6d4358"
  ctx.fillRect(Math.round(x), Math.round(y + 54), 32, 10)
}

function drawFallbackTable(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = "#9d7548"
  ctx.fillRect(Math.round(x), Math.round(y), 64, 48)
  ctx.strokeStyle = "#6f4c2d"
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, 64, 48)
}

function queueWorkstationDrawables(
  drawables: SceneDrawable[],
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  active: boolean,
  hovered: boolean,
  assets: PixelAgentAssets | null,
  time: number,
  alpha = 1,
) {
  if (alpha <= 0) return
  drawables.push({
    zY: y - 16,
    draw: () => drawDeskAndComputer(ctx, x, y, active, hovered, assets, time, alpha),
  })
  drawables.push({
    zY: y + 18,
    draw: () => drawChairBack(ctx, x, y, active, hovered, assets, alpha),
  })
}

function queueCharacterDrawable(
  drawables: SceneDrawable[],
  ctx: CanvasRenderingContext2D,
  character: SceneCharacter,
  motion: CodexActivityMotion,
  tool: CodexActivityTool,
  hovered: boolean,
  assets: PixelAgentAssets | null,
  time: number,
) {
  const anchorY = character.y + CHARACTER_HEIGHT - 12
  const zY =
    character.phase === "resting"
      ? anchorY + 8 * CHARACTER_SCALE + 0.5
      : anchorY + 16 + character.targetX / 10000
  drawables.push({
    zY,
    draw: () => {
      const spriteMotion = character.phase === "resting" ? "typing" : motion
      drawCharacterFrame(ctx, {
        x: character.x,
        y: character.y,
        motion: spriteMotion,
        tool,
        frame: Math.floor(time * animationSpeed(spriteMotion)) % 4,
        palette: character.palette,
        alpha: character.alpha,
        selected: hovered,
        assets,
        direction: characterDirection(character, motion),
        scale: CHARACTER_SCALE,
        showProp: character.phase !== "resting",
      })
    },
  })
}

function queueWhiteCatDrawable(
  drawables: SceneDrawable[],
  ctx: CanvasRenderingContext2D,
  cat: SceneWhiteCat,
  assets: PixelAgentAssets | null,
  time: number,
) {
  const anchorY = cat.y + WHITE_CAT_SIZE_PX - 8 * WHITE_CAT_SCALE
  drawables.push({
    zY: anchorY + cat.x / 10000,
    draw: () => {
      if (!assets?.whiteCat) {
        return
      }
      const frame = Math.floor((time - cat.phaseStartedAt) * WHITE_CAT_ANIMATION_SPEED[cat.action])
      drawWhiteCatShadow(ctx, cat)
      drawWhiteCatFrame(ctx, assets, {
        x: cat.x,
        y: cat.y,
        action: cat.action,
        frame,
        scale: WHITE_CAT_SCALE,
        flipX: cat.facing === "left",
      })
    },
  })
}

function drawWhiteCatShadow(ctx: CanvasRenderingContext2D, cat: SceneWhiteCat) {
  ctx.fillStyle = "rgba(48, 38, 27, 0.08)"
  ctx.fillRect(
    Math.round(cat.x + 12 * WHITE_CAT_SCALE),
    Math.round(cat.y + WHITE_CAT_SHADOW_Y_OFFSET_PX),
    Math.round(25 * WHITE_CAT_SCALE),
    Math.round(3 * WHITE_CAT_SCALE),
  )
}

function renderDrawables(drawables: SceneDrawable[]) {
  drawables.sort((a, b) => a.zY - b.zY)
  for (const drawable of drawables) {
    drawable.draw()
  }
}

function drawDeskAndComputer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  active: boolean,
  hovered: boolean,
  assets: PixelAgentAssets | null,
  time: number,
  alpha: number,
) {
  const scale = CHARACTER_SCALE
  const deskX = x - DESK_LEFT_OFFSET_PX
  const deskY = y - 40 * scale
  drawOfficeAsset(ctx, assets, {
    key: "deskFront",
    x: deskX,
    y: deskY,
    scale,
    alpha: alpha * (active ? 1 : 0.82),
  })

  const pcFrame = active ? (["pcFrontOn1", "pcFrontOn2", "pcFrontOn3"] as const)[Math.floor(time * 4) % 3] : "pcFrontOff"
  drawOfficeAsset(ctx, assets, {
    key: pcFrame,
    x: deskX + 16 * scale,
    y: deskY,
    scale,
    alpha: alpha * (active ? 1 : 0.78),
  })
  drawModernOfficeSprite(ctx, assets, {
    source: MODERN_DESK_LAMP_SOURCE,
    x: deskX + 6,
    y: deskY,
    scale: 0.58,
    alpha: alpha * (active ? 1 : 0.72),
  })
  drawOfficeAsset(ctx, assets, {
    key: "coffee",
    x: deskX + 28 * scale,
    y: deskY + 17 * scale,
    scale: 1.6,
    alpha: alpha * (active ? 1 : 0.6),
  })

  if (hovered) {
    ctx.strokeStyle = "#e4d16f"
    ctx.lineWidth = 2
    ctx.strokeRect(Math.round(deskX - 2), Math.round(deskY - 2), 48 * scale + 4, 32 * scale + 4)
  }
}

function drawChairBack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  active: boolean,
  hovered: boolean,
  assets: PixelAgentAssets | null,
  alpha: number,
) {
  const scale = CHARACTER_SCALE
  drawSeatShadow(ctx, x, y, active, hovered, alpha)
  drawOfficeAsset(ctx, assets, {
    key: "woodenChairBack",
    x: x - 8 * scale,
    y: y - 24 * scale,
    scale,
    alpha: alpha * (active ? 1 : 0.76),
  })
}

function drawSeatShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  active: boolean,
  hovered: boolean,
  alpha = 1,
) {
  ctx.fillStyle = hovered
    ? `rgba(238, 214, 124, ${0.24 * alpha})`
    : active
      ? `rgba(27, 33, 39, ${0.24 * alpha})`
      : `rgba(27, 33, 39, ${0.14 * alpha})`
  ctx.fillRect(Math.round(x - 28), Math.round(y + 4), 56, 12)
}

function drawHoverTarget(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: PixelDirection,
) {
  const width = direction === "up" ? 112 : 92
  ctx.strokeStyle = "rgba(242, 216, 110, 0.58)"
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(x - width / 2), Math.round(y - 82), width, 106)
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  motion: CodexActivityMotion,
  hovered: boolean,
  stage?: string,
) {
  const width = Math.max(38, Math.min(168, text.length * 8 + 16))
  ctx.fillStyle = "#fbf8ef"
  ctx.fillRect(Math.round(x - width / 2), Math.round(y), width, hovered ? 30 : 24)
  ctx.fillStyle = bubbleTone(motion, stage)
  ctx.fillRect(Math.round(x - width / 2), Math.round(y), width, 4)
  ctx.strokeStyle = hovered ? "#6d6255" : "#897f70"
  ctx.strokeRect(Math.round(x - width / 2), Math.round(y), width, hovered ? 30 : 24)
  ctx.fillStyle = "#5a5044"
  ctx.font = "10px \"Pixel Agents\", ui-monospace, SFMono-Regular, Consolas, monospace"
  ctx.textAlign = "center"
  ctx.fillText(text, Math.round(x), Math.round(y + (hovered ? 19 : 16)), width - 8)
  ctx.textAlign = "start"
}

function drawOverflowBadge(ctx: CanvasRenderingContext2D, width: number, hiddenCount: number) {
  ctx.fillStyle = "#ece2d2"
  ctx.fillRect(width - 58, 14, 42, 22)
  ctx.strokeStyle = "#9a8c78"
  ctx.strokeRect(width - 58, 14, 42, 22)
  ctx.fillStyle = "#5f5548"
  ctx.font = "12px ui-monospace, SFMono-Regular, Consolas, monospace"
  ctx.fillText(`+${hiddenCount}`, width - 44, 29)
}

function bubbleTone(motion: CodexActivityMotion, stage?: string) {
  const stageTone = stageBubbleTone(stage)
  if (stageTone) return stageTone
  if (motion === "failure") return "#d96f5f"
  if (motion === "success") return "#79ad78"
  if (motion === "waiting") return "#d8b35e"
  if (motion === "running") return "#8b95a6"
  if (motion === "typing") return "#8fa46b"
  return "#76a6a8"
}

function stageBubbleTone(stage: string | undefined) {
  if (stage === "part1") return PART1_BUBBLE_TONE
  if (stage === "part2") return PART2_BUBBLE_TONE
  return null
}

function activityGlyph(kind: CodexActivityAgent["activityKind"] | undefined, motion: CodexActivityMotion) {
  if (motion === "walking") return "..."
  const labels: Record<CodexActivityAgent["activityKind"], string> = {
    booting: "BOOT",
    thinking: "...",
    command: "CMD",
    tool: "TOOL",
    writing: "EDIT",
    todo: "TODO",
    searching: "FIND",
    waiting: "WAIT",
    done: "OK",
    failed: "ERR",
    canceled: "STOP",
  }
  return kind ? labels[kind] : "OK"
}

function hoveredBubbleText(character: SceneCharacter) {
  const agent = character.agent
  if (!agent) {
    return character.exitMotion === "success" ? "完成" : "结束"
  }
  const issue = agent.issueIdentifier || "RUN"
  return `${issue} ${agent.activityLabel}`
}

function animationSpeed(motion: CodexActivityMotion) {
  if (motion === "typing" || motion === "running") return 8
  if (motion === "walking") return 6
  if (motion === "reading") return 3
  return 2
}

function exitMotionForRun(lastRun: RunSummary | undefined, runId: string): CodexActivityMotion {
  if (lastRun?.id !== runId) {
    return "success"
  }
  if (lastRun.status === "succeeded") return "success"
  if (lastRun.status === "failed" || lastRun.status === "canceled") return "failure"
  return "success"
}
