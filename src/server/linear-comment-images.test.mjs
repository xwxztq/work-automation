import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"
import { isLinearImageUrl, readLinearImage, verifyLinearCommentImages } from "./linear-comment-images.mjs"
import { imageHash, imageCommentBody } from "./run-images.mjs"

const url1 = "https://uploads.linear.app/workspace/image-one/test.png"
const url2 = "https://uploads.linear.app/workspace/image-two/test.jpg"
function fixture() {
  const bytes = [Buffer.from("first image"), Buffer.from("second image")]
  const operation = { payload: { body: "检查通过。\n\n关键产物如下。" } }
  const images = bytes.map((b, i) => ({ filePath: `${i}.png`, caption: `场景 ${i}`, contentType: "image/png", sha256: imageHash(b), size: b.length }))
  const intent = { commentId: "comment-1", images }
  const comment = { id: intent.commentId, body: imageCommentBody(operation.payload.body, images, [url1, url2]) }
  const readImage = async (url) => bytes[url === url1 ? 0 : 1]
  return { bytes, operation, intent, comment, readImage }
}

test("verifies transformed Linear URLs by original bytes in the declared order", async () => {
  const f = fixture()
  assert.deepEqual(await verifyLinearCommentImages(f), { status: "verified", resourceId: "comment-1", references: [url1, url2] })
  for (const body of [f.comment.body.replace(url1, url2), f.comment.body.replace("检查通过", "检查失败"), f.comment.body.split("\n\n").slice(0,-1).join("\n\n"), f.comment.body.replace(url1, "https://evil.example/image")]) {
    assert.equal((await verifyLinearCommentImages({ ...f, comment: { ...f.comment, body } })).status, "conflict")
  }
  assert.equal((await verifyLinearCommentImages({ ...f, readImage: async () => Buffer.from("changed") })).status, "conflict")
  assert.equal((await verifyLinearCommentImages({ ...f, comment: { ...f.comment, archivedAt: "today" } })).status, "conflict")
})

test("accepts unchanged data URIs, rejects changed bytes and propagates read throttling", async () => {
  const f = fixture()
  f.comment.body = imageCommentBody(f.operation.payload.body, f.intent.images, f.bytes.map(b => `data:image/png;base64,${b.toString("base64")}`))
  assert.equal((await verifyLinearCommentImages(f)).status, "verified")
  f.intent.images[0].sha256 = "0".repeat(64)
  assert.equal((await verifyLinearCommentImages(f)).status, "conflict")
  const original = fixture()
  await assert.rejects(verifyLinearCommentImages({ ...original, readImage: async () => { throw Object.assign(new Error("throttled"), { code: "RATE_LIMITED" }) } }), { code: "RATE_LIMITED" })
})

test("authenticated image reader rejects attacker URLs before any network call", async () => {
  let calls = 0
  for (const url of ["http://uploads.linear.app/a/b", "https://uploads.linear.app.evil.example/a/b", "https://user:pass@uploads.linear.app/a/b", "https://uploads.linear.app:444/a/b", "https://uploads.linear.app/a/b?token=secret", "https://127.0.0.1/a/b", "https://uploads.linear.app/a/%2e%2e/secret", "file:///tmp/image"]) {
    assert.equal(isLinearImageUrl(url), false)
    await assert.rejects(readLinearImage(url, "test-key", 10, { request() { calls++ } }), { code: "INVALID_REQUEST" })
  }
  assert.equal(calls, 0)
})

function fakeRequest(status, chunks, seen) {
  return (_url, options, callback) => {
    seen.push(options)
    const request = new EventEmitter()
    request.destroy = () => { request.emit("error", new Error("closed")); request.emit("close") }
    request.end = () => {
      const response = new PassThrough()
      response.statusCode = status
      callback(response)
      for (const chunk of chunks) response.write(Buffer.from(chunk))
      response.end()
      request.emit("close")
    }
    return request
  }
}

test("image reader bounds bytes and refuses redirects without leaking credentials", async () => {
  const seen = []
  assert.deepEqual(await readLinearImage(url1, "test-key", 3, { request: fakeRequest(200, ["abc"], seen) }), Buffer.from("abc"))
  assert.equal(seen[0].headers.Authorization, "test-key")
  await assert.rejects(readLinearImage(url1, "test-key", 3, { request: fakeRequest(200, ["abcd"], seen) }), { code: "CONFLICT" })
  await assert.rejects(readLinearImage(url1, "test-key", 3, { request: fakeRequest(302, [], seen) }), { code: "CONFLICT" })
  await assert.rejects(readLinearImage(url1, "test-key", 3, { request: fakeRequest(429, [], seen) }), { code: "RATE_LIMITED", retryable: true })
})
