import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { PNG } from "pngjs"
import jpeg from "jpeg-js"
import { inspectImage, readRunImage, prepareRunImages, recheckRunImages, RUN_IMAGE_LIMITS } from "./run-images.mjs"

const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) })
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "run-images-"))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const root = path.join(base, "run")
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, "image.png"), png)
  await fs.writeFile(path.join(base, "outside.png"), png)
  return { base, root }
}
function input(images = [{ filePath: "image.png" }], body = "检查结果") {
  return { operation: { type: "comment.create", payload: { body, images } } }
}

test("reads bounded PNG/JPEG content and computes MIME and SHA-256 from bytes", async (t) => {
  const { root } = await fixture(t)
  assert.deepEqual(await readRunImage(root, "image.png"), png)
  assert.equal(inspectImage(png).contentType, "image/png")
  const jpg = jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }).data
  assert.equal(inspectImage(jpg).contentType, "image/jpeg")
  assert.match(inspectImage(jpg).sha256, /^[a-f0-9]{64}$/u)
  for (const bytes of [Buffer.from("<svg></svg>"), Buffer.from("not a PNG"), png.subarray(0, 32), Buffer.concat([png, Buffer.from("payload")]), jpg.subarray(0, -2)]) {
    assert.throws(() => inspectImage(bytes), { code: "INVALID_REQUEST" })
  }
  const corrupt = Buffer.from(png); corrupt[40] ^= 1
  assert.throws(() => inspectImage(corrupt))
  const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16)
  assert.throws(() => inspectImage(bomb))
})

test("rejects absolute paths, traversal, aliases and unsupported filesystem entries without blocking", { timeout: 30000 }, async (t) => {
  const { root, base } = await fixture(t)
  await fs.mkdir(path.join(root, "directory"))
  await fs.symlink(path.join(base, "outside.png"), path.join(root, "link.png"))
  await fs.symlink(base, path.join(root, "linked-parent"))
  await fs.link(path.join(base, "outside.png"), path.join(root, "hardlink.png"))
  execFileSync("mkfifo", [path.join(root, "pipe")])
  for (const name of ["../outside.png", "/etc/passwd", "C:\\secret.png", "./image.png", "directory/../image.png", "directory", "link.png", "linked-parent/outside.png", "hardlink.png", "pipe", "missing", "image.png\0", "directory//a"]) {
    await assert.rejects(readRunImage(root, name), { code: "INVALID_REQUEST" })
  }
  const alias = path.join(base, "run-alias")
  await fs.symlink(root, alias)
  await assert.rejects(readRunImage(alias, "image.png"))
  await fs.symlink("/dev/null", path.join(root, "device"))
  await assert.rejects(readRunImage(root, "device"))
})

test("detects file and parent replacement between inspection and read", async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(readRunImage(root, "image.png", { afterOpen: () => fs.writeFile(path.join(root, "image.png"), Buffer.from("changed")) }), { code: "CONFLICT" })
  await fs.mkdir(path.join(root, "parent"))
  await fs.writeFile(path.join(root, "parent/image.png"), png)
  await assert.rejects(readRunImage(root, "parent/image.png", { afterOpen: async () => {
    await fs.rename(path.join(root, "parent"), path.join(root, "old"))
    await fs.symlink(path.join(root, "old"), path.join(root, "parent"))
  } }))
})

test("rejects a same-size content change after batch preflight", async (t) => {
  const { root } = await fixture(t)
  const batch = [input()]
  await prepareRunImages({ dir: root }, batch)
  const changed = Buffer.from(png); changed[40] ^= 1
  await fs.writeFile(path.join(root, "image.png"), changed)
  await assert.rejects(recheckRunImages({ dir: root }, batch), { code: "CONFLICT" })
})

test("enforces inclusive file size and total/count/encoded request bounds", async (t) => {
  const { root } = await fixture(t)
  assert.deepEqual(await readRunImage(root, "image.png", { fileBytes: png.length }), png)
  await assert.rejects(readRunImage(root, "image.png", { fileBytes: png.length - 1 }))
  await fs.writeFile(path.join(root, "oversize.png"), Buffer.alloc(RUN_IMAGE_LIMITS.fileBytes + 1))
  await assert.rejects(readRunImage(root, "oversize.png"))
  await assert.rejects(prepareRunImages({ dir: root }, [input(), input(), input(), input(), input()]))
  await assert.rejects(prepareRunImages({ dir: root }, [input(), input()], { limits: { ...RUN_IMAGE_LIMITS, totalBytes: png.length * 2 - 1 } }))
  await prepareRunImages({ dir: root }, [input(), input()], { limits: { ...RUN_IMAGE_LIMITS, totalBytes: png.length * 2 } })
  await assert.rejects(prepareRunImages({ dir: root }, [input()], { limits: { ...RUN_IMAGE_LIMITS, requestBytes: 4096 } }))
})

test("durable manifests detect replay changes and allow read-only recovery after file removal", async (t) => {
  const { root } = await fixture(t)
  const first = input()
  await prepareRunImages({ dir: root }, [first])
  const existing = { attempts: 0, intent: first.imageIntent }
  const replay = { ...input(), existing }
  await prepareRunImages({ dir: root }, [replay])
  assert.equal(first.imageIntent.requestFingerprint, replay.imageIntent.requestFingerprint)
  await fs.writeFile(path.join(root, "image.png"), PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 0) }))
  await assert.rejects(prepareRunImages({ dir: root }, [replay]), { code: "CONFLICT" })
  existing.attempts = 1
  await assert.rejects(prepareRunImages({ dir: root }, [replay]), { code: "CONFLICT" })
  await fs.unlink(path.join(root, "image.png"))
  await prepareRunImages({ dir: root }, [{ ...input(), existing }])
  existing.attempts = 0
  await assert.rejects(prepareRunImages({ dir: root }, [{ ...input(), existing }]))
})

test("preflights final comment character and escaped request byte limits for the whole batch", async (t) => {
  const { root } = await fixture(t)
  const image = input()
  await prepareRunImages({ dir: root }, [image])
  const suffixLength = image.imageBody.length - image.operation.payload.body.length
  await prepareRunImages({ dir: root }, [input(undefined, "x".repeat(RUN_IMAGE_LIMITS.bodyCharacters - suffixLength))])
  await assert.rejects(prepareRunImages({ dir: root }, [input(undefined, "x".repeat(RUN_IMAGE_LIMITS.bodyCharacters - suffixLength + 1))]))
  await assert.rejects(prepareRunImages({ dir: root }, [input([]), input([], "\0".repeat(100000))]))
})
