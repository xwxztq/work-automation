import type { CodexActivityMotion, CodexActivityTool } from "@/shared/types"

type PixelPalette = {
  skin: string
  hair: string
  shirt: string
  shirtDark: string
  pants: string
  shoe: string
}

export type PixelFloorColor = {
  h: number
  s: number
  b: number
  c: number
}

export type PixelSpriteRect = {
  x: number
  y: number
  width: number
  height: number
}

export type PixelCatAction =
  | "idle"
  | "itch"
  | "laying"
  | "licking1"
  | "licking2"
  | "meow"
  | "run"
  | "sitting"
  | "sleeping1"
  | "sleeping2"
  | "stretching"
  | "walk"

type PixelCatAssets = Record<PixelCatAction, HTMLImageElement>

type PixelOfficeLayout = {
  version: 1
  cols: number
  rows: number
  tiles: number[]
  tileColors?: Array<PixelFloorColor | null>
}

export type PixelDirection = "down" | "up" | "right" | "left"

type FurnitureAssetKey =
  | "bookshelf"
  | "clock"
  | "coffee"
  | "coffeeTable"
  | "deskFront"
  | "largePlant"
  | "pcFrontOff"
  | "pcFrontOn1"
  | "pcFrontOn2"
  | "pcFrontOn3"
  | "plant"
  | "smallPainting"
  | "sofaBack"
  | "sofaFront"
  | "sofaSide"
  | "whiteboard"
  | "woodenChairBack"

export type PixelAgentAssets = {
  characters: HTMLImageElement[]
  floors: HTMLImageElement[]
  furniture: Record<FurnitureAssetKey, HTMLImageElement>
  modernOffice: HTMLImageElement
  whiteCat: PixelCatAssets | null
  layout: PixelOfficeLayout
}

type DrawCharacterFrameInput = {
  x: number
  y: number
  motion: CodexActivityMotion
  tool: CodexActivityTool
  frame: number
  palette: number
  alpha?: number
  selected?: boolean
  assets?: PixelAgentAssets | null
  direction?: PixelDirection
  scale?: number
  showProp?: boolean
}

type DrawAssetInput = {
  key: FurnitureAssetKey
  x: number
  y: number
  scale?: number
  scaleX?: number
  scaleY?: number
  alpha?: number
  flipX?: boolean
}

type DrawSpriteSheetInput = {
  source: PixelSpriteRect
  x: number
  y: number
  scale?: number
  alpha?: number
  flipX?: boolean
}

type DrawCatFrameInput = {
  x: number
  y: number
  action: PixelCatAction
  frame: number
  scale?: number
  alpha?: number
  flipX?: boolean
}

const PIXEL = 4
const CHAR_FRAME_WIDTH = 16
const CHAR_FRAME_HEIGHT = 32
const CAT_FRAME_SIZE = 50
const ASSET_BASE = "/pixel-agents/assets"
const WHITE_CAT_BASE = `${ASSET_BASE}/pets/white-cat`
const DEFAULT_FLOOR_COLOR: PixelFloorColor = { h: 0, s: 0, b: 0, c: 0 }

const FURNITURE_SOURCES: Record<FurnitureAssetKey, string> = {
  bookshelf: `${ASSET_BASE}/furniture/BOOKSHELF/BOOKSHELF.png`,
  clock: `${ASSET_BASE}/furniture/CLOCK/CLOCK.png`,
  coffee: `${ASSET_BASE}/furniture/COFFEE/COFFEE.png`,
  coffeeTable: `${ASSET_BASE}/furniture/COFFEE_TABLE/COFFEE_TABLE.png`,
  deskFront: `${ASSET_BASE}/furniture/DESK/DESK_FRONT.png`,
  largePlant: `${ASSET_BASE}/furniture/LARGE_PLANT/LARGE_PLANT.png`,
  pcFrontOff: `${ASSET_BASE}/furniture/PC/PC_FRONT_OFF.png`,
  pcFrontOn1: `${ASSET_BASE}/furniture/PC/PC_FRONT_ON_1.png`,
  pcFrontOn2: `${ASSET_BASE}/furniture/PC/PC_FRONT_ON_2.png`,
  pcFrontOn3: `${ASSET_BASE}/furniture/PC/PC_FRONT_ON_3.png`,
  plant: `${ASSET_BASE}/furniture/PLANT/PLANT.png`,
  smallPainting: `${ASSET_BASE}/furniture/SMALL_PAINTING/SMALL_PAINTING.png`,
  sofaBack: `${ASSET_BASE}/furniture/SOFA/SOFA_BACK.png`,
  sofaFront: `${ASSET_BASE}/furniture/SOFA/SOFA_FRONT.png`,
  sofaSide: `${ASSET_BASE}/furniture/SOFA/SOFA_SIDE.png`,
  whiteboard: `${ASSET_BASE}/furniture/WHITEBOARD/WHITEBOARD.png`,
  woodenChairBack: `${ASSET_BASE}/furniture/WOODEN_CHAIR/WOODEN_CHAIR_BACK.png`,
}

const WHITE_CAT_SOURCES: Record<PixelCatAction, string> = {
  idle: `${WHITE_CAT_BASE}/idle.png`,
  itch: `${WHITE_CAT_BASE}/itch.png`,
  laying: `${WHITE_CAT_BASE}/laying.png`,
  licking1: `${WHITE_CAT_BASE}/licking-1.png`,
  licking2: `${WHITE_CAT_BASE}/licking-2.png`,
  meow: `${WHITE_CAT_BASE}/meow.png`,
  run: `${WHITE_CAT_BASE}/run.png`,
  sitting: `${WHITE_CAT_BASE}/sitting.png`,
  sleeping1: `${WHITE_CAT_BASE}/sleeping-1.png`,
  sleeping2: `${WHITE_CAT_BASE}/sleeping-2.png`,
  stretching: `${WHITE_CAT_BASE}/stretching.png`,
  walk: `${WHITE_CAT_BASE}/walk.png`,
}

const PALETTES: PixelPalette[] = [
  { skin: "#c98762", hair: "#564037", shirt: "#52706a", shirtDark: "#405954", pants: "#5d6470", shoe: "#47423b" },
  { skin: "#8f5d43", hair: "#332a26", shirt: "#9d6a4c", shirtDark: "#7d513b", pants: "#555f69", shoe: "#403a34" },
  { skin: "#d6a271", hair: "#73533d", shirt: "#646f8b", shirtDark: "#4d5872", pants: "#5b626b", shoe: "#4b443c" },
  { skin: "#b77453", hair: "#46372e", shirt: "#7a6a4a", shirtDark: "#62553d", pants: "#545e68", shoe: "#423c35" },
]

let cachedAssetsPromise: Promise<PixelAgentAssets> | null = null
const colorizedFloorCache = new Map<string, HTMLCanvasElement>()

export function loadPixelAgentAssets() {
  cachedAssetsPromise ??= Promise.all([
    Promise.all(Array.from({ length: 6 }, (_, index) => loadImage(`${ASSET_BASE}/characters/char_${index}.png`))),
    Promise.all(Array.from({ length: 9 }, (_, index) => loadImage(`${ASSET_BASE}/floors/floor_${index}.png`))),
    Promise.all(
      Object.entries(FURNITURE_SOURCES).map(async ([key, src]) => {
        const image = await loadImage(src)
        return [key, image] as const
      }),
    ),
    loadImage(`${ASSET_BASE}/furniture/Modern%20Office%2048x48.png`),
    loadWhiteCatAssets().catch(() => null),
    loadLayout(),
  ]).then(([characters, floors, furnitureEntries, modernOffice, whiteCat, layout]) => ({
    characters,
    floors,
    furniture: Object.fromEntries(furnitureEntries) as Record<FurnitureAssetKey, HTMLImageElement>,
    modernOffice,
    whiteCat,
    layout,
  }))
  return cachedAssetsPromise
}

export function paletteIndexFromId(id: string) {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  }
  return hash % 6
}

export function drawCharacterFrame(
  ctx: CanvasRenderingContext2D,
  input: DrawCharacterFrameInput,
) {
  if (drawCharacterAssetFrame(ctx, input)) {
    return
  }
  drawFallbackCharacterFrame(ctx, input)
}

export function drawOfficeAsset(
  ctx: CanvasRenderingContext2D,
  assets: PixelAgentAssets | null | undefined,
  { key, x, y, scale = 2, scaleX = scale, scaleY = scale, alpha = 1, flipX = false }: DrawAssetInput,
) {
  const image = assets?.furniture[key]
  if (!isImageReady(image)) {
    return false
  }

  const targetWidth = image.width * scaleX
  const targetHeight = image.height * scaleY

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.imageSmoothingEnabled = false
  if (flipX) {
    ctx.translate(Math.round(x + targetWidth), Math.round(y))
    ctx.scale(-1, 1)
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight)
  } else {
    ctx.drawImage(image, Math.round(x), Math.round(y), targetWidth, targetHeight)
  }
  ctx.restore()
  return true
}

export function drawFloorTile(
  ctx: CanvasRenderingContext2D,
  assets: PixelAgentAssets | null | undefined,
  floorIndex: number,
  x: number,
  y: number,
  size: number,
) {
  const image = assets?.floors[floorIndex]
  if (!isImageReady(image)) {
    return false
  }
  ctx.drawImage(image, Math.round(x), Math.round(y), size, size)
  return true
}

export function drawModernOfficeSprite(
  ctx: CanvasRenderingContext2D,
  assets: PixelAgentAssets | null | undefined,
  { source, x, y, scale = 1, alpha = 1, flipX = false }: DrawSpriteSheetInput,
) {
  const image = assets?.modernOffice
  if (!isImageReady(image)) {
    return false
  }

  const targetWidth = Math.round(source.width * scale)
  const targetHeight = Math.round(source.height * scale)

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.imageSmoothingEnabled = false
  if (flipX) {
    ctx.translate(Math.round(x + targetWidth), Math.round(y))
    ctx.scale(-1, 1)
    ctx.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, targetWidth, targetHeight)
  } else {
    ctx.drawImage(
      image,
      source.x,
      source.y,
      source.width,
      source.height,
      Math.round(x),
      Math.round(y),
      targetWidth,
      targetHeight,
    )
  }
  ctx.restore()
  return true
}

export function drawWhiteCatFrame(
  ctx: CanvasRenderingContext2D,
  assets: PixelAgentAssets | null | undefined,
  { x, y, action, frame, scale = 1, alpha = 1, flipX = false }: DrawCatFrameInput,
) {
  const image = assets?.whiteCat?.[action]
  if (!isImageReady(image)) {
    return false
  }

  const frameCount = Math.max(1, Math.floor(image.width / CAT_FRAME_SIZE))
  const sourceFrame = frame % frameCount
  const targetSize = Math.round(CAT_FRAME_SIZE * scale)

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.imageSmoothingEnabled = false
  if (flipX) {
    ctx.translate(Math.round(x + targetSize), Math.round(y))
    ctx.scale(-1, 1)
    ctx.drawImage(
      image,
      sourceFrame * CAT_FRAME_SIZE,
      0,
      CAT_FRAME_SIZE,
      CAT_FRAME_SIZE,
      0,
      0,
      targetSize,
      targetSize,
    )
  } else {
    ctx.drawImage(
      image,
      sourceFrame * CAT_FRAME_SIZE,
      0,
      CAT_FRAME_SIZE,
      CAT_FRAME_SIZE,
      Math.round(x),
      Math.round(y),
      targetSize,
      targetSize,
    )
  }
  ctx.restore()
  return true
}

export function drawColorizedFloorTile(
  ctx: CanvasRenderingContext2D,
  assets: PixelAgentAssets | null | undefined,
  floorPattern: number,
  color: PixelFloorColor | null | undefined,
  x: number,
  y: number,
  size: number,
) {
  const image = assets?.floors[floorPattern - 1]
  if (!isImageReady(image)) {
    return false
  }
  const tile = getColorizedFloorCanvas(image, color || DEFAULT_FLOOR_COLOR)
  ctx.drawImage(tile, Math.round(x), Math.round(y), size, size)
  return true
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load Pixel Agents asset: ${src}`))
    image.src = src
  })
}

async function loadLayout() {
  const response = await fetch(`${ASSET_BASE}/default-layout-1.json`)
  if (!response.ok) {
    throw new Error(`Failed to load Pixel Agents layout: ${response.status}`)
  }
  return (await response.json()) as PixelOfficeLayout
}

async function loadWhiteCatAssets() {
  const entries = await Promise.all(
    Object.entries(WHITE_CAT_SOURCES).map(async ([action, src]) => {
      const image = await loadImage(src)
      return [action, image] as const
    }),
  )
  return Object.fromEntries(entries) as PixelCatAssets
}

function getColorizedFloorCanvas(image: HTMLImageElement, color: PixelFloorColor) {
  const key = `${image.src}:${color.h}:${color.s}:${color.b}:${color.c}`
  const cached = colorizedFloorCache.get(key)
  if (cached) {
    return cached
  }

  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext("2d")
  if (!context) {
    return canvas
  }

  context.drawImage(image, 0, 0)
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const pixels = imageData.data
  const saturation = color.s / 100

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) {
      continue
    }

    const red = pixels[index]
    const green = pixels[index + 1]
    const blue = pixels[index + 2]
    let lightness = (0.299 * red + 0.587 * green + 0.114 * blue) / 255

    if (color.c !== 0) {
      const contrastFactor = (100 + color.c) / 100
      lightness = 0.5 + (lightness - 0.5) * contrastFactor
    }
    if (color.b !== 0) {
      lightness += color.b / 200
    }
    lightness = clamp01(lightness)

    const [nextRed, nextGreen, nextBlue] = hslToRgb(color.h, saturation, lightness)
    pixels[index] = nextRed
    pixels[index + 1] = nextGreen
    pixels[index + 2] = nextBlue
  }

  context.putImageData(imageData, 0, 0)
  colorizedFloorCache.set(key, canvas)
  return canvas
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const huePrime = hue / 60
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1))
  let red = 0
  let green = 0
  let blue = 0

  if (huePrime < 1) {
    red = chroma
    green = x
  } else if (huePrime < 2) {
    red = x
    green = chroma
  } else if (huePrime < 3) {
    green = chroma
    blue = x
  } else if (huePrime < 4) {
    green = x
    blue = chroma
  } else if (huePrime < 5) {
    red = x
    blue = chroma
  } else {
    red = chroma
    blue = x
  }

  const match = lightness - chroma / 2
  return [clamp255(red + match), clamp255(green + match), clamp255(blue + match)]
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function clamp255(value: number) {
  return Math.max(0, Math.min(255, Math.round(value * 255)))
}

function drawCharacterAssetFrame(ctx: CanvasRenderingContext2D, input: DrawCharacterFrameInput) {
  const { assets, palette, alpha = 1, scale = 2 } = input
  const image = assets?.characters[palette % Math.max(assets.characters.length, 1)]
  if (!isImageReady(image)) {
    return false
  }

  const direction = input.direction || directionForMotion(input.motion)
  const { row, flipX } = spriteRowForDirection(direction)
  const frame = spriteFrameForMotion(input.motion, input.frame, input.tool)
  const sx = frame * CHAR_FRAME_WIDTH
  const sy = row * CHAR_FRAME_HEIGHT
  const targetWidth = CHAR_FRAME_WIDTH * scale
  const targetHeight = CHAR_FRAME_HEIGHT * scale
  const x = Math.round(input.x)
  const y = Math.round(input.y)

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.imageSmoothingEnabled = false
  if (flipX) {
    ctx.translate(Math.round(x + targetWidth), y)
    ctx.scale(-1, 1)
    ctx.drawImage(image, sx, sy, CHAR_FRAME_WIDTH, CHAR_FRAME_HEIGHT, 0, 0, targetWidth, targetHeight)
  } else {
    ctx.drawImage(image, sx, sy, CHAR_FRAME_WIDTH, CHAR_FRAME_HEIGHT, x, y, targetWidth, targetHeight)
  }
  ctx.restore()
  return true
}

function spriteFrameForMotion(motion: CodexActivityMotion, frame: number, tool: CodexActivityTool) {
  if (motion === "walking") {
    return [0, 1, 2, 1][frame % 4]
  }
  if (motion === "typing" || motion === "running") {
    return tool === "search" ? 5 + (frame % 2) : 3 + (frame % 2)
  }
  if (motion === "reading") {
    return 5 + (frame % 2)
  }
  return 1
}

function directionForMotion(motion: CodexActivityMotion): PixelDirection {
  if (motion === "typing" || motion === "reading" || motion === "running") {
    return "up"
  }
  return "down"
}

function spriteRowForDirection(direction: PixelDirection) {
  if (direction === "up") return { row: 1, flipX: false }
  if (direction === "right") return { row: 2, flipX: false }
  if (direction === "left") return { row: 2, flipX: true }
  return { row: 0, flipX: false }
}

function isImageReady(image: HTMLImageElement | undefined): image is HTMLImageElement {
  return !!image && image.complete && image.naturalWidth > 0
}

function drawFallbackCharacterFrame(
  ctx: CanvasRenderingContext2D,
  { x, y, motion, tool, frame, palette, alpha = 1, selected = false, showProp = true }: DrawCharacterFrameInput,
) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.imageSmoothingEnabled = false

  if (selected) {
    rect(ctx, x - 8, y - 8, 80, 100, "rgba(109, 98, 85, 0.18)")
    rect(ctx, x - 4, y - 4, 72, 4, "#b7a48d")
    rect(ctx, x - 4, y + 84, 72, 4, "#b7a48d")
  }

  const p = PALETTES[palette % PALETTES.length]
  const pose = poseForMotion(motion, frame)
  const bob = pose.bob * PIXEL
  const baseX = Math.round(x)
  const baseY = Math.round(y + bob)

  drawShadow(ctx, baseX, baseY)
  drawLegs(ctx, baseX, baseY, p, pose)
  drawBody(ctx, baseX, baseY, p, tool)
  drawArms(ctx, baseX, baseY, p, pose, motion)
  drawHead(ctx, baseX, baseY, p, pose)
  if (showProp) {
    drawProp(ctx, baseX, baseY, motion, tool, frame)
  }

  ctx.restore()
}

function poseForMotion(motion: CodexActivityMotion, frame: number) {
  if (motion === "walking") {
    return {
      bob: frame % 2 === 0 ? -1 : 0,
      leftArm: frame % 2 === 0 ? -1 : 1,
      rightArm: frame % 2 === 0 ? 1 : -1,
      leg: frame % 2 === 0 ? 1 : -1,
    }
  }
  if (motion === "typing" || motion === "running") {
    return {
      bob: 0,
      leftArm: frame % 2 === 0 ? 1 : 0,
      rightArm: frame % 2 === 0 ? 0 : 1,
      leg: 0,
    }
  }
  if (motion === "reading") {
    return { bob: frame % 2 === 0 ? 0 : -0.3, leftArm: 0, rightArm: 0, leg: 0 }
  }
  if (motion === "success") {
    return { bob: frame % 2 === 0 ? -1 : 0, leftArm: -2, rightArm: -2, leg: 0 }
  }
  if (motion === "failure") {
    return { bob: 0, leftArm: 1, rightArm: 1, leg: 0 }
  }
  return { bob: 0, leftArm: 0, rightArm: 0, leg: 0 }
}

function drawShadow(ctx: CanvasRenderingContext2D, x: number, y: number) {
  rect(ctx, x + 4, y + 76, 56, 8, "rgba(90, 78, 61, 0.22)")
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  p: PixelPalette,
  pose: ReturnType<typeof poseForMotion>,
) {
  rect(ctx, x + 20, y + 0, 24, 8, p.hair)
  rect(ctx, x + 16, y + 8, 32, 20, p.skin)
  rect(ctx, x + 16, y + 8, 8, 12, p.hair)
  rect(ctx, x + 40, y + 8, 8, 12, p.hair)
  rect(ctx, x + 24, y + 16, 4, 4, "#4f4539")
  rect(ctx, x + 36, y + 16, 4, 4, "#4f4539")
  if (pose.leftArm < -1) {
    rect(ctx, x + 28, y + 24, 12, 4, "#6b4c3f")
  } else if (pose.leftArm > 0 && pose.rightArm > 0) {
    rect(ctx, x + 28, y + 24, 8, 4, "#6b4c3f")
  }
}

function drawBody(ctx: CanvasRenderingContext2D, x: number, y: number, p: PixelPalette, tool: CodexActivityTool) {
  rect(ctx, x + 16, y + 28, 32, 28, p.shirt)
  rect(ctx, x + 16, y + 28, 8, 24, p.shirtDark)
  rect(ctx, x + 40, y + 28, 8, 24, p.shirtDark)
  if (tool === "linear") {
    rect(ctx, x + 28, y + 34, 8, 8, "#77a9ad")
  } else if (tool === "test") {
    rect(ctx, x + 28, y + 34, 8, 8, "#d8b35e")
  } else if (tool === "git") {
    rect(ctx, x + 28, y + 34, 8, 8, "#9a8fba")
  }
}

function drawArms(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  p: PixelPalette,
  pose: ReturnType<typeof poseForMotion>,
  motion: CodexActivityMotion,
) {
  rect(ctx, x + 8, y + 32 + pose.leftArm * PIXEL, 12, 8, p.shirtDark)
  rect(ctx, x + 44, y + 32 + pose.rightArm * PIXEL, 12, 8, p.shirtDark)
  rect(ctx, x + 8, y + 40 + pose.leftArm * PIXEL, 12, 8, p.skin)
  rect(ctx, x + 44, y + 40 + pose.rightArm * PIXEL, 12, 8, p.skin)
  if (motion === "failure") {
    rect(ctx, x + 10, y + 48, 8, 4, "#6b4c3f")
    rect(ctx, x + 46, y + 48, 8, 4, "#6b4c3f")
  }
}

function drawLegs(ctx: CanvasRenderingContext2D, x: number, y: number, p: PixelPalette, pose: ReturnType<typeof poseForMotion>) {
  rect(ctx, x + 20, y + 56, 12, 20 + pose.leg * PIXEL, p.pants)
  rect(ctx, x + 32, y + 56, 12, 20 - pose.leg * PIXEL, p.pants)
  rect(ctx, x + 16, y + 76 + pose.leg * PIXEL, 16, 8, p.shoe)
  rect(ctx, x + 32, y + 76 - pose.leg * PIXEL, 16, 8, p.shoe)
}

function drawProp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  motion: CodexActivityMotion,
  tool: CodexActivityTool,
  frame: number,
) {
  if (motion === "reading") {
    rect(ctx, x + 12, y + 42, 40, 16, "#f0e8da")
    rect(ctx, x + 16, y + 46, 12, 2, propColor(tool))
    rect(ctx, x + 16, y + 52, 24, 2, "#9a8c78")
    return
  }
  if (motion === "typing" || motion === "running") {
    rect(ctx, x + 13, y + 48, 38, 10, "#4f5659")
    rect(ctx, x + 17 + (frame % 3) * 8, y + 51, 5, 3, propColor(tool))
  }
}

function propColor(tool: CodexActivityTool) {
  if (tool === "linear") return "#77a9ad"
  if (tool === "test") return "#d8b35e"
  if (tool === "git") return "#9a8fba"
  if (tool === "search") return "#75a0a0"
  if (tool === "edit" || tool === "todo") return "#8fa46b"
  return "#9cb0c9"
}

function rect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height))
}
