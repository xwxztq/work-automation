import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { resolveExecutable } from "./executable.mjs"

const execute = promisify(execFile)
export const GIT_CHECKOUT_REFUSED = 78
export const GIT_BRANCH_DEFAULTS = Object.freeze({ base: "", create: true, mode: "auto" })

export function validGitBranch(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 240 && name !== "HEAD" && name !== "@" &&
    !/^[.-]|[\s\x00-\x1f\x7f~^:?*[\\]|\.\.|@\{|\.$/u.test(name) &&
    name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
}

export async function readGitCheckout(cwd) {
  let gitBin = await resolveExecutable(process.platform === "win32" ? "git.exe" : "git", { cwd })
  if (!gitBin) throw new Error("在 WA 宿主找不到 Git。")
  if (process.platform === "win32" && path.basename(path.dirname(gitBin)).toLowerCase() === "cmd") {
    // Git for Windows puts a shim in cmd and portable runtime DLLs beside
    // the actual executable. Pass the actual executable into the sandbox.
    const execPath = await gitCommands(gitBin, cwd).run("--exec-path")
    const actualBin = path.resolve(execPath, "../../bin/git.exe")
    const relative = path.relative(path.resolve(gitBin, "../.."), actualBin)
    if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      gitBin = await resolveExecutable(actualBin, { cwd }) || gitBin
    }
  }
  const git = gitCommands(gitBin, cwd)
  let root
  try { root = await fs.realpath(await git.run("rev-parse", "--show-toplevel")) } catch {
    throw new Error("仓库路径必须指向可读取的 Git 工作树。")
  }
  return { gitBin, repository: root, branch: await git.branch() }
}

export function planGitBranch({ checkout, project, issue, runs }) {
  const { repository } = checkout
  const { base, create, mode } = project.gitBranch
  const matching = runs.filter((run) => run.projectKey === project.key &&
    run.gitBranch?.repository === repository && run.gitBranch.base === base &&
    run.gitBranch.create === create && run.gitBranch.mode === mode)
  const parentIssueId = issue.parentIssueId || issue.parent?.id || null
  const previous = matching.find((run) => run.issueId === issue.id)
  let branch = base
  if (create) {
    if (previous) branch = previous.gitBranch.branch
    else if (mode === "continuous") {
      const suffix = createHash("sha256").update(JSON.stringify([project.key, project.workspaceId || "default", base])).digest("hex").slice(0, 14)
      branch = `codex/wa-continuous-${suffix}`
    } else {
      const shared = mode === "auto" ? relatedBranches(issue, parentIssueId, matching) : new Set()
      branch = shared.size === 1 ? [...shared][0] : `codex/wa-${randomUUID().slice(0, 13)}`
    }
  }
  return { repository, base, branch, create, mode, parentIssueId }
}

function relatedBranches(issue, parentIssueId, matching) {
  const predecessors = new Set((issue.relations || []).filter((relation) =>
    !relation.archivedAt && ((relation.direction === "incoming" && relation.type === "blocks") ||
      (relation.direction === "outgoing" && relation.type?.toLowerCase() === "blockedby")),
  ).map((relation) => relation.issue?.id).filter(Boolean))
  const branches = new Set()
  for (const run of matching) {
    if (run.status !== "succeeded") continue
    if (predecessors.has(run.issueId) || (parentIssueId && (run.issueId === parentIssueId ||
      run.gitBranch.parentIssueId === parentIssueId)) || run.gitBranch.parentIssueId === issue.id) {
      branches.add(run.gitBranch.branch)
    }
  }
  return branches
}

// Called inside the existing Codex sandbox. Checkout filters therefore run
// without host credentials and inside the same filesystem boundary as Codex.
export async function checkoutGitBranch(plan, environment = process.env) {
  const { base, branch, create, gitBin, repository } = plan
  if (!validGitBranch(base) || !validGitBranch(branch) || (!create && branch !== base)) throw new Error("Git 分支配置无效。")
  const git = gitCommands(gitBin, repository, environment)
  const original = await git.branch()
  const originalHead = await git.run("rev-parse", "--verify", "HEAD")
  const gitDir = await git.run("rev-parse", "--absolute-git-dir")
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"]) {
    if (await fs.stat(path.join(gitDir, marker)).then(() => true, (error) => {
      if (error.code !== "ENOENT") throw error
      return false
    })) throw new Error("Git 工作树正在进行合并、变基或其他操作，暂缓分支任务。")
  }
  if (!await git.clean()) throw new Error("Git 工作树有未提交改动，暂缓分支任务。")
  if (original !== branch) {
    if (await git.hasRef(`refs/heads/${branch}`)) {
      await git.switch("--", branch)
    } else {
      if (!create) throw new Error(`找不到本地 Git 基线分支 ${base}。`)
      const baseRef = await git.hasRef(`refs/heads/${base}`) ? `refs/heads/${base}` : `refs/remotes/${base}`
      if (!await git.hasRef(baseRef)) throw new Error(`找不到 Git 基线分支 ${base}。`)
      await git.switch("--no-track", "-c", branch, baseRef)
    }
  }
  return {
    isOnBranch: async () => await git.branch() === branch,
    async restore() {
      if (await git.branch() !== branch) return false
      if (original === branch) return true
      if (!await git.clean()) return false
      if (original) await git.switch("--", original)
      else await git.switch("--detach", originalHead)
      return true
    },
  }
}

function gitCommands(gitBin, cwd, env = process.env) {
  async function run(...args) {
    const { stdout } = await execute(gitBin, ["--no-optional-locks", "-c", "core.fsmonitor=false",
      "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], {
      cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  }
  return {
    run,
    switch: (...args) => run("switch", "--no-guess", "--no-overwrite-ignore", "--no-recurse-submodules", ...args),
    async branch() {
      try {
        const ref = await run("symbolic-ref", "--quiet", "HEAD")
        return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null
      } catch (error) {
        if (error.code !== 1) throw error
        return null
      }
    },
    async hasRef(ref) {
      try { await run("show-ref", "--verify", "--quiet", ref); return true } catch (error) {
        if (error.code !== 1) throw error
        return false
      }
    },
    async clean() { return !await run("status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none") },
  }
}
