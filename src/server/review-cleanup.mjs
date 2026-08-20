import fs from "node:fs/promises"
import path from "node:path"

export const REVIEW_TEMP_ENTRIES = Object.freeze([
  "_work",
  "_commit-snapshot",
  "_commit-snapshot.tar",
  "_implementation",
  "_baseline",
  "snapshots",
  ".tmp-worktree",
  ".tooling",
  ".runtime-parent",
  ".runtime-after",
  ".compiled-parent",
  ".compiled-after",
  "tmp",
  "node_modules",
])

export async function cleanupReviewTempArtifacts(runDir) {
  if (typeof runDir !== "string" || !runDir.trim()) {
    return { reviewDir: null, removedEntries: [] }
  }

  const reviewDir = path.resolve(runDir, "review")
  const reviewStat = await lstatOptional(reviewDir)
  if (!reviewStat?.isDirectory()) {
    return { reviewDir, removedEntries: [] }
  }

  const removedEntries = []
  for (const entry of REVIEW_TEMP_ENTRIES) {
    const target = path.resolve(reviewDir, entry)
    if (path.dirname(target) !== reviewDir) {
      throw new Error(`拒绝清理 review 目录外的路径: ${target}`)
    }
    if (!(await lstatOptional(target))) {
      continue
    }
    await fs.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 50,
    })
    removedEntries.push(entry)
  }

  return { reviewDir, removedEntries }
}

async function lstatOptional(filePath) {
  try {
    return await fs.lstat(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }
    throw error
  }
}
