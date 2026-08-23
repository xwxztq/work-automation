import test from "node:test"
import assert from "node:assert/strict"

import {
  drawCharacterFrame,
  loadPixelAgentAssets,
} from "../components/codex-activity/pixelSprites.ts"

test("optional Modern Office failure preserves core assets and horizontal character frames", async (t) => {
  const OriginalImage = globalThis.Image
  const originalFetch = globalThis.fetch

  class FixtureImage {
    complete = false
    naturalWidth = 0
    width = 16
    height = 96
    onload = null
    onerror = null
    #src = ""

    get src() {
      return this.#src
    }

    set src(value) {
      this.#src = value
      queueMicrotask(() => {
        if (value.includes("Modern%20Office")) {
          this.onerror?.()
          return
        }
        this.complete = true
        this.naturalWidth = this.width
        this.onload?.()
      })
    }
  }

  globalThis.Image = FixtureImage
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { version: 1, cols: 1, rows: 1, tiles: [1] }
    },
  })
  t.after(() => {
    globalThis.Image = OriginalImage
    globalThis.fetch = originalFetch
  })

  const assets = await loadPixelAgentAssets()
  assert.equal(assets.modernOffice, null)
  assert.equal(assets.characters.length, 6)
  assert.equal(assets.floors.length, 9)
  assert.ok(assets.furniture.deskFront)

  const leftContext = drawingContextFixture()
  drawCharacterFrame(leftContext, {
    x: 10,
    y: 20,
    motion: "walking",
    tool: "other",
    frame: 1,
    palette: 0,
    assets,
    direction: "left",
  })
  assert.equal(leftContext.drawImageCalls[0][2], 64)
  assert.deepEqual(leftContext.scaleCalls, [[-1, 1]])

  const rightContext = drawingContextFixture()
  drawCharacterFrame(rightContext, {
    x: 10,
    y: 20,
    motion: "walking",
    tool: "other",
    frame: 1,
    palette: 0,
    assets,
    direction: "right",
  })
  assert.equal(rightContext.drawImageCalls[0][2], 64)
  assert.deepEqual(rightContext.scaleCalls, [])
})

function drawingContextFixture() {
  return {
    drawImageCalls: [],
    scaleCalls: [],
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    translate() {},
    scale(x, y) {
      this.scaleCalls.push([x, y])
    },
    drawImage(...args) {
      this.drawImageCalls.push(args)
    },
  }
}
