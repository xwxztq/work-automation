import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import jpeg from "jpeg-js"
import { PNG } from "pngjs"
import { IssuePlatformError } from "./issue-platform.mjs"

export const RUN_IMAGE_LIMITS = Object.freeze({
  // Linear commentCreate rejected bodies above 100000 characters (2026-09-13).
  // 64 KiB passed live; retain room for text and enforce the final body limit too.
  fileBytes: 64 * 1024,
  count: 4,
  totalBytes: 256 * 1024,
  requestBytes: 512 * 1024,
  bodyCharacters: 100000,
  pixels: 16 * 1024 * 1024,
})

export function imageError(code = "INVALID_REQUEST") {
  return new IssuePlatformError({ code, operation: "comment.create", path: "$.payload.images" })
}

export function imageHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
}

// Root ancestors may include OS aliases (e.g. /var on macOS). The run root
// itself and every component inside it must be real directories/files.
async function inspectPath(root, relative) {
  if (!root || typeof relative !== "string" || !relative || relative.includes("\\") ||
      /[\u0000-\u001f]/u.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.split("/").some((part) => !part || part === "." || part === "..")) throw imageError()
  const rootStat = await fs.lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw imageError()
  const realRoot = await fs.realpath(root)
  const snapshots = [[path.resolve(root), identity(rootStat)]]
  let current = realRoot
  const parts = relative.split("/")
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const stat = await fs.lstat(current, { bigint: true })
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw imageError()
    // Hard links to files outside the run must not become an alternate read path.
    if (stat.isFile() && stat.nlink !== 1n) throw imageError()
    snapshots.push([current, identity(stat)])
  }
  if (await fs.realpath(current) !== current) throw imageError()
  return { filename: current, realRoot, snapshots }
}

export async function readRunImage(root, relative, { fileBytes = RUN_IMAGE_LIMITS.fileBytes, afterOpen, allowMissing = false } = {}) {
  let handle
  try {
    const before = await inspectPath(root, relative)
    // O_NONBLOCK prevents a raced-in FIFO from hanging before fstat can reject it.
    handle = await fs.open(before.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || identity(stat) !== before.snapshots.at(-1)[1] || stat.size <= 0n || stat.size > BigInt(fileBytes)) throw imageError()
    await afterOpen?.()
    const bytes = Buffer.alloc(Number(stat.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await inspectPath(root, relative)
    if (length !== Number(stat.size) || identity(await handle.stat({ bigint: true })) !== identity(stat) ||
        JSON.stringify(before) !== JSON.stringify(after)) throw imageError("CONFLICT")
    return bytes.subarray(0, length)
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null
    if (error instanceof IssuePlatformError) throw error
    throw imageError()
  } finally {
    await handle?.close()
  }
}

export function inspectImage(bytes) {
  try {
    let contentType
    let decoded
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      if (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(8) !== 13) throw imageError()
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (!width || !height || width * height > RUN_IMAGE_LIMITS.pixels) throw imageError()
      // Reject trailing data and animated PNG; the comment must show one image.
      let offset = 8
      let ended = false
      const compressed = []
      while (offset + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(offset)
        const type = bytes.toString("ascii", offset + 4, offset + 8)
        if ((type === "IHDR" && offset !== 8) || type === "acTL" || offset + size + 12 > bytes.length) throw imageError()
        if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + size))
        offset += size + 12
        if (type === "IEND") { ended = size === 0; break }
      }
      if (!ended || offset !== bytes.length) throw imageError()
      // pngjs interlaced decoding otherwise uses an unbounded inflateSync.
      inflateSync(Buffer.concat(compressed), { maxOutputLength: width * height * 8 + height * 8 + 1024 })
      decoded = PNG.sync.read(bytes, { checkCRC: true })
      contentType = "image/png"
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
      decoded = jpeg.decode(bytes, { tolerantDecoding: false, maxResolutionInMP: 16, maxMemoryUsageInMB: 128 })
      contentType = "image/jpeg"
    } else {
      throw imageError()
    }
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > RUN_IMAGE_LIMITS.pixels) throw imageError()
    return { contentType, size: bytes.length, sha256: imageHash(bytes) }
  } catch {
    throw imageError()
  }
}

export function imageAlt(image, index) {
  return (image.caption || `图片 ${index + 1}`).replace(/[\\[\]]/gu, "\\$&")
}

export function imageCommentBody(body, images, references) {
  return body.trimEnd() + images.map((image, index) => `\n\n![${imageAlt(image, index)}](${references[index]})`).join("")
}

export async function prepareRunImages(run, inputs, { limits = RUN_IMAGE_LIMITS } = {}) {
  let count = 0
  let totalBytes = 0
  for (const input of inputs) {
    if (input.operation.type === "comment.create" &&
        (input.operation.payload.body.length > limits.bodyCharacters ||
          Buffer.byteLength(JSON.stringify({ body: input.operation.payload.body })) + 4096 > limits.requestBytes)) throw imageError()
    const declarations = input.operation.payload.images || []
    count += declarations.length
    if (count > limits.count) throw imageError()
    if (!declarations.length) continue
    const existing = input.existing
    const saved = existing?.intent?.images
    // A previously attempted write is resolved only from its durable manifest and
    // remote UUID. Local artifacts are no longer a reason to upload it again.
    if (existing?.attempts > 0) {
      if (!saved || saved.length !== declarations.length) throw imageError("CONFLICT")
      for (const image of saved) {
        const bytes = await readRunImage(run.dir, image.filePath, { ...limits, allowMissing: true })
        if (bytes && imageHash(bytes) !== image.sha256) throw imageError("CONFLICT")
      }
      totalBytes += saved.reduce((sum, image) => sum + image.size, 0)
      input.imageIntent = existing.intent
    } else {
      const images = []
      const references = []
      for (const declaration of declarations) {
        const bytes = await readRunImage(run.dir, declaration.filePath, limits)
        const metadata = inspectImage(bytes)
        totalBytes += metadata.size
        if (totalBytes > limits.totalBytes) throw imageError()
        images.push({ ...declaration, ...metadata })
        references.push(`data:${metadata.contentType};base64,${bytes.toString("base64")}`)
      }
      input.imageBody = imageCommentBody(input.operation.payload.body, images, references)
      input.imageIntent = { images, requestFingerprint: imageHash(Buffer.from(input.imageBody)) }
      if (saved && (JSON.stringify(saved) !== JSON.stringify(images) || existing.intent.requestFingerprint !== input.imageIntent.requestFingerprint)) throw imageError("CONFLICT")
      // Includes GraphQL envelope allowance; adapter checks the exact envelope too.
      if (input.imageBody.length > limits.bodyCharacters || Buffer.byteLength(JSON.stringify({ body: input.imageBody })) + 4096 > limits.requestBytes) throw imageError()
    }
    if (totalBytes > limits.totalBytes) throw imageError()
  }
}

export async function recheckRunImages(run, inputs) {
  // All images are rechecked together immediately before the first mutation.
  // Writes consume the preflight bytes, never a subsequent filesystem read.
  for (const input of inputs) {
    if (!input.imageBody) continue
    for (const image of input.imageIntent.images) {
      const bytes = await readRunImage(run.dir, image.filePath)
      if (imageHash(bytes) !== image.sha256) throw imageError("CONFLICT")
    }
  }
}
