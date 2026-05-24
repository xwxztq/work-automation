import { useEffect, useMemo, useRef } from "react"

import type {
  CodexActivityAgent,
  CodexActivityMotion,
  CodexActivityTool,
  RunSummary,
} from "@/shared/types"

import {
  drawCharacterFrame,
  drawOfficeAsset,
  loadPixelAgentAssets,
  paletteIndexFromId,
  type PixelAgentAssets,
  type PixelDirection,
} from "./pixelSprites"

const MAX_SCENE_AGENTS = 4
const CHARACTER_SCALE = 2
const CHARACTER_WIDTH = 16 * CHARACTER_SCALE
const CHARACTER_HEIGHT = 32 * CHARACTER_SCALE
const DESK_APPEAR_DURATION_SEC = 0.9
const REST_DURATION_SEC = 5

type CodexActivitySceneProps = {
  agents: CodexActivityAgent[]
  lastRun?: RunSummary
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
}

type SceneCharacterPhase = "entering" | "working" | "walkingToRest" | "resting" | "exiting"

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

export function CodexActivityScene({ agents, lastRun, onSelectRun }: CodexActivitySceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const agentsRef = useRef<CodexActivityAgent[]>([])
  const totalAgentsRef = useRef(0)
  const lastRunRef = useRef<RunSummary | undefined>(lastRun)
  const onSelectRunRef = useRef(onSelectRun)
  const charactersRef = useRef(new Map<string, SceneCharacter>())
  const hitRegionsRef = useRef<HitRegion[]>([])
  const hoveredRunIdRef = useRef<string | null>(null)
  const assetsRef = useRef<PixelAgentAssets | null>(null)
  const visibleAgents = useMemo(() => agents.slice(0, MAX_SCENE_AGENTS), [agents])
  const ariaLabel = useMemo(() => {
    if (agents.length === 0) {
      return lastRun
        ? `Codex 空闲，最近运行 ${lastRun.issueIdentifier} ${lastRun.status}`
        : "Codex 空闲，暂无运行记录"
    }
    return `Codex 活动场景，${agents.length} 个运行中任务，点击小人可查看运行详情`
  }, [agents.length, lastRun])

  useEffect(() => {
    agentsRef.current = visibleAgents
    totalAgentsRef.current = agents.length
    lastRunRef.current = lastRun
  }, [agents.length, visibleAgents, lastRun])

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
      drawingContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawingContext.imageSmoothingEnabled = false
      drawScene({
        ctx: drawingContext,
        width,
        height,
        agents: agentsRef.current,
        totalAgents: totalAgentsRef.current,
        lastRun: lastRunRef.current,
        characters: charactersRef.current,
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
      className="h-[230px] min-w-0 overflow-hidden rounded-lg border bg-[#111722]"
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
  lastRun,
  characters,
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
  lastRun: RunSummary | undefined
  characters: Map<string, SceneCharacter>
  hitRegions: HitRegion[]
  hoveredRunId: string | null
  assets: PixelAgentAssets | null
  time: number
  dt: number
}) {
  ctx.clearRect(0, 0, width, height)
  drawOffice(ctx, width, height, assets)
  syncCharacters(characters, agents, lastRun, width, height, time)
  updateCharacters(characters, dt, time, width, height)

  hitRegions.length = 0

  if (agents.length === 0 && characters.size === 0) {
    const rest = restAreaPosition(width, height)
    const drawables: SceneDrawable[] = []
    queueRestAreaDrawables(drawables, ctx, rest.x, rest.y, assets)
    renderDrawables(drawables)
    return
  }

  const rest = restAreaPosition(width, height)
  const orderedCharacters = [...characters.values()]
  const drawables: SceneDrawable[] = []
  queueRestAreaDrawables(drawables, ctx, rest.x, rest.y, assets)
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
        motion,
        tool,
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
      drawBubble(ctx, bubble.x, bubble.y, bubble.text, motion, hovered)
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

  if (totalAgents > MAX_SCENE_AGENTS) {
    drawOverflowBadge(ctx, width, totalAgents - MAX_SCENE_AGENTS)
  }
}

function syncCharacters(
  characters: Map<string, SceneCharacter>,
  agents: CodexActivityAgent[],
  lastRun: RunSummary | undefined,
  width: number,
  height: number,
  time: number,
) {
  const activeIds = new Set(agents.map((agent) => agent.runId))
  const slotCount = Math.max(1, agents.length)
  const slots = agents.map((agent, index) => ({
    agent,
    slot: index,
    ...slotPosition(index, slotCount, width, height),
  }))

  for (const { agent, slot, x, y } of slots) {
    const targetX = x - CHARACTER_WIDTH / 2
    const targetY = y - CHARACTER_HEIGHT + 12
    const existing = characters.get(agent.runId)
    if (existing) {
      existing.targetX = targetX
      existing.targetY = targetY
      existing.stationX = x
      existing.stationY = y
      existing.slot = slot
      existing.agent = agent
      if (existing.phase !== "entering" && existing.phase !== "working") {
        existing.phase = "entering"
        existing.phaseStartedAt = time
      }
      continue
    }

    characters.set(agent.runId, {
      runId: agent.runId,
      x: -CHARACTER_WIDTH - 24,
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
    })
  }

  for (const character of characters.values()) {
    if (
      activeIds.has(character.runId) ||
      character.phase === "walkingToRest" ||
      character.phase === "resting" ||
      character.phase === "exiting"
    ) {
      continue
    }
    const rest = restAreaPosition(width, height)
    character.phase = "walkingToRest"
    character.phaseStartedAt = time
    character.agent = null
    character.targetX = rest.seatedAnchorX - CHARACTER_WIDTH / 2
    character.targetY = rest.seatedAnchorY - CHARACTER_HEIGHT + 6 * CHARACTER_SCALE
    character.exitMotion = exitMotionForRun(lastRun, character.runId)
    character.exitTool = "other"
  }
}

function updateCharacters(
  characters: Map<string, SceneCharacter>,
  dt: number,
  time: number,
  width: number,
  height: number,
) {
  for (const [runId, character] of characters.entries()) {
    const follow = Math.min(1, dt * 5.5)
    character.x += (character.targetX - character.x) * follow
    character.y += (character.targetY - character.y) * follow

    if (character.phase === "entering" && isNearTarget(character, 2.5)) {
      character.phase = "working"
      character.phaseStartedAt = time
      character.x = character.targetX
      character.y = character.targetY
    }

    if (character.phase === "walkingToRest" && isNearTarget(character, 2.5)) {
      character.phase = "resting"
      character.phaseStartedAt = time
      character.x = character.targetX
      character.y = character.targetY
    }

    if (character.phase === "resting" && time - character.phaseStartedAt >= REST_DURATION_SEC) {
      const rest = restAreaPosition(width, height)
      character.phase = "exiting"
      character.phaseStartedAt = time
      character.targetX = width + CHARACTER_WIDTH + 24
      character.targetY = rest.seatedAnchorY - CHARACTER_HEIGHT
    }

    character.alpha = 1

    if (character.phase === "exiting" && character.x > width + CHARACTER_WIDTH) {
      characters.delete(runId)
    }
  }
}

function slotPosition(index: number, count: number, width: number, height: number) {
  const workRight = width >= 520 ? width * 0.56 : width * 0.62
  const workLeft = 28
  const workWidth = Math.max(180, workRight - workLeft)

  if (count <= 2) {
    const x = workLeft + workWidth * (count === 1 ? 0.5 : index === 0 ? 0.28 : 0.72)
    const y = height * 0.72
    return { x, y }
  }

  const column = index % 2
  const row = Math.floor(index / 2)
  const x = workLeft + workWidth * (column === 0 ? 0.28 : 0.72)
  const y = height * (row === 0 ? 0.54 : 0.82)
  return { x, y }
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
    return "up"
  }
  if (motion === "walking") {
    if (character.targetX > character.x + 4) return "right"
    if (character.targetX < character.x - 4) return "left"
    return "down"
  }
  if (motion === "typing" || motion === "reading" || motion === "running") {
    return "up"
  }
  return "down"
}

function isNearTarget(character: SceneCharacter, threshold: number) {
  return (
    Math.abs(character.targetX - character.x) <= threshold &&
    Math.abs(character.targetY - character.y) <= threshold
  )
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
) {
  if (character.phase === "exiting") return null
  if (character.phase === "entering" || character.phase === "working") {
    return {
      x: character.stationX,
      y: character.stationY - 124,
      text: hovered
        ? hoveredBubbleText(character)
        : activityGlyph(character.agent?.activityKind, motion),
    }
  }
  return {
    x: characterAnchorX(character),
    y: character.y - 28,
    text: character.exitMotion === "failure" ? "ERR" : "OK",
  }
}

function drawOffice(ctx: CanvasRenderingContext2D, width: number, height: number, assets: PixelAgentAssets | null) {
  ctx.fillStyle = "#111722"
  ctx.fillRect(0, 0, width, height)

  const wallHeight = Math.max(62, height * 0.34)
  ctx.fillStyle = "#263547"
  ctx.fillRect(0, 0, width, wallHeight)
  ctx.fillStyle = "#1d2a3a"
  ctx.fillRect(0, wallHeight - 8, width, 8)

  const tileSize = 32
  for (let y = wallHeight; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      drawOfficeTile(ctx, x, y, tileSize, x < width * 0.56 ? "wood" : "stone")
    }
  }

  ctx.fillStyle = "rgba(17, 23, 34, 0.34)"
  ctx.fillRect(0, wallHeight, width, 4)
  ctx.fillStyle = "#151b28"
  ctx.fillRect(0, height - 6, width, 6)

  const decorScale = 1.8
  drawOfficeAsset(ctx, assets, { key: "bookshelf", x: 18, y: wallHeight - 58, scale: decorScale })
  drawOfficeAsset(ctx, assets, { key: "bookshelf", x: 78, y: wallHeight - 58, scale: decorScale })
  drawOfficeAsset(ctx, assets, { key: "whiteboard", x: width - 100, y: wallHeight - 62, scale: decorScale })
  drawOfficeAsset(ctx, assets, { key: "clock", x: width * 0.52, y: 12, scale: 1.7 })
  drawOfficeAsset(ctx, assets, { key: "largePlant", x: width - 54, y: height - 104, scale: 1.8 })
  drawOfficeAsset(ctx, assets, { key: "plant", x: 12, y: height - 82, scale: 1.7 })
  drawOfficeAsset(ctx, assets, { key: "smallPainting", x: width - 156, y: wallHeight - 62, scale: 1.6 })
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
  const x = width >= 520 ? width * 0.75 : width * 0.62
  const y = height * 0.48
  const seatedAnchorX = x
  const seatedAnchorY = y + 40 * scale
  return { x, y, seatedAnchorX, seatedAnchorY }
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
  motion: CodexActivityMotion,
  tool: CodexActivityTool,
  active: boolean,
  hovered: boolean,
  assets: PixelAgentAssets | null,
  time: number,
  alpha = 1,
) {
  if (alpha <= 0) return
  drawables.push({
    zY: y - 16,
    draw: () => drawDeskAndComputer(ctx, x, y, motion, tool, active, hovered, assets, time, alpha),
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
  const zY = character.phase === "resting" ? anchorY + 8 * CHARACTER_SCALE + 0.5 : anchorY + 16
  drawables.push({
    zY,
    draw: () => {
      drawCharacterFrame(ctx, {
        x: character.x,
        y: character.y,
        motion,
        tool,
        frame: Math.floor(time * animationSpeed(motion)) % 4,
        palette: character.palette,
        alpha: character.alpha,
        selected: hovered,
        assets,
        direction: characterDirection(character, motion),
        scale: CHARACTER_SCALE,
      })
    },
  })
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
  motion: CodexActivityMotion,
  tool: CodexActivityTool,
  active: boolean,
  hovered: boolean,
  assets: PixelAgentAssets | null,
  time: number,
  alpha: number,
) {
  const scale = CHARACTER_SCALE
  const deskX = x - 24 * scale
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
  drawOfficeAsset(ctx, assets, {
    key: "coffee",
    x: deskX + 33 * scale,
    y: deskY + 17 * scale,
    scale: 1.6,
    alpha: alpha * (active ? 1 : 0.6),
  })

  if (hovered) {
    ctx.strokeStyle = "#e4d16f"
    ctx.lineWidth = 2
    ctx.strokeRect(Math.round(deskX - 2), Math.round(deskY - 2), 48 * scale + 4, 32 * scale + 4)
  }

  const monitorGlow = monitorColor(motion, tool, active)
  ctx.fillStyle = monitorGlow
  ctx.globalAlpha = alpha
  ctx.fillRect(Math.round(deskX + 21 * scale), Math.round(deskY + 7 * scale), 6 * scale, 3 * scale)
  if (active && motion !== "waiting" && motion !== "idle") {
    ctx.fillStyle = "rgba(246, 203, 111, 0.74)"
    ctx.fillRect(Math.round(deskX + 37 * scale), Math.round(deskY + 8 * scale), 3 * scale, 3 * scale)
  }
  ctx.globalAlpha = 1
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
) {
  const width = Math.max(38, Math.min(168, text.length * 8 + 16))
  ctx.fillStyle = "#fbf8ef"
  ctx.fillRect(Math.round(x - width / 2), Math.round(y), width, hovered ? 30 : 24)
  ctx.fillStyle = bubbleTone(motion)
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

function monitorColor(motion: CodexActivityMotion, tool: CodexActivityTool, active: boolean) {
  if (!active) return "#d8d0c2"
  if (motion === "failure") return "#d96f5f"
  if (motion === "success") return "#7bbf8a"
  if (motion === "waiting") return "#e2c36f"
  if (tool === "linear") return "#77a9ad"
  if (tool === "test") return "#8b95a6"
  if (tool === "edit" || tool === "todo") return "#8fa46b"
  if (tool === "git") return "#9a8fba"
  if (tool === "search") return "#75a0a0"
  return "#9cb0c9"
}

function bubbleTone(motion: CodexActivityMotion) {
  if (motion === "failure") return "#d96f5f"
  if (motion === "success") return "#79ad78"
  if (motion === "waiting") return "#d8b35e"
  if (motion === "running") return "#8b95a6"
  if (motion === "typing") return "#8fa46b"
  return "#76a6a8"
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
