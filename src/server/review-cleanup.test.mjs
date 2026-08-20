import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  REVIEW_TEMP_ENTRIES,
  cleanupReviewTempArtifacts,
} from "./review-cleanup.mjs"

test("removes only review temporary workspaces and dependency copies", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-review-cleanup-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  const runDir = path.join(rootDir, "runs", "run-1")
  const reviewDir = path.join(runDir, "review")
  await fs.mkdir(path.join(reviewDir, "gui"), { recursive: true })
  await fs.mkdir(path.join(reviewDir, "api"), { recursive: true })
  await fs.mkdir(path.join(reviewDir, "logs"), { recursive: true })
  await fs.writeFile(path.join(reviewDir, "summary.md"), "summary")
  await fs.writeFile(path.join(reviewDir, "manifest.json"), "{}")
  await fs.writeFile(path.join(reviewDir, "gui", "screen.after.png"), "image")
  await fs.writeFile(path.join(reviewDir, "api", "response.diff.md"), "diff")
  await fs.writeFile(path.join(reviewDir, "logs", "validation.log"), "log")
  await fs.writeFile(path.join(reviewDir, "custom-evidence.html"), "evidence")

  for (const entry of REVIEW_TEMP_ENTRIES) {
    const target = path.join(reviewDir, entry)
    if (path.extname(entry)) {
      await fs.writeFile(target, "temporary")
    } else {
      await fs.mkdir(path.join(target, "node_modules", "package"), { recursive: true })
      await fs.writeFile(path.join(target, "node_modules", "package", "index.js"), "temporary")
    }
  }

  const result = await cleanupReviewTempArtifacts(runDir)

  assert.deepEqual(result.removedEntries.sort(), [...REVIEW_TEMP_ENTRIES].sort())
  for (const entry of REVIEW_TEMP_ENTRIES) {
    await assert.rejects(fs.lstat(path.join(reviewDir, entry)), { code: "ENOENT" })
  }
  assert.equal(await fs.readFile(path.join(reviewDir, "summary.md"), "utf8"), "summary")
  assert.equal(await fs.readFile(path.join(reviewDir, "manifest.json"), "utf8"), "{}")
  assert.equal(await fs.readFile(path.join(reviewDir, "gui", "screen.after.png"), "utf8"), "image")
  assert.equal(await fs.readFile(path.join(reviewDir, "api", "response.diff.md"), "utf8"), "diff")
  assert.equal(await fs.readFile(path.join(reviewDir, "logs", "validation.log"), "utf8"), "log")
  assert.equal(await fs.readFile(path.join(reviewDir, "custom-evidence.html"), "utf8"), "evidence")
})

test("does not follow a review symlink", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-review-symlink-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  const runDir = path.join(rootDir, "run")
  const outsideDir = path.join(rootDir, "outside")
  await fs.mkdir(runDir, { recursive: true })
  await fs.mkdir(path.join(outsideDir, "_work"), { recursive: true })
  await fs.writeFile(path.join(outsideDir, "_work", "keep.txt"), "keep")
  await fs.symlink(outsideDir, path.join(runDir, "review"))

  const result = await cleanupReviewTempArtifacts(runDir)

  assert.deepEqual(result.removedEntries, [])
  assert.equal(await fs.readFile(path.join(outsideDir, "_work", "keep.txt"), "utf8"), "keep")
})
