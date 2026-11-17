import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { saveConfig } from "./config.mjs"
import { checkoutGitBranch, planGitBranch, readGitCheckout, GIT_CHECKOUT_REFUSED } from "./git-branch.mjs"
import { buildCodexPermissionBoundary, buildCodexSandboxArgs, prepareCodexSandboxOutputs, resolveExecutableReadPaths } from "./codex-permissions.mjs"
import { buildCodexSandboxTargetArgs } from "./codex-runner.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"
import { resolveExecutable } from "./executable.mjs"

const execute = promisify(execFile)
const target = new URL("./codex-sandbox-target.mjs", import.meta.url)

test("branch planning separates unrelated issues and retries, chains and respects disabled creation", () => {
  const checkout = { repository: "repo" }
  const project = { key: "project", gitBranch: { base: "main", create: true, mode: "auto" } }
  const plan = (issue, runs = []) => planGitBranch({ checkout, project, issue, runs })
  const first = plan({ id: "ISS-1" })
  const history = [{ projectKey: project.key, issueId: "ISS-1", gitBranch: first, status: "succeeded" }]
  assert.equal(plan({ id: "ISS-1" }, history).branch, first.branch)
  assert.equal(plan({ id: "ISS-2", parentIssueId: "ISS-1" }, history).branch, first.branch)
  assert.equal(plan({ id: "ISS-2", relations: [{ direction: "incoming", type: "blocks", issue: { id: "ISS-1" } }] }, history).branch, first.branch)
  assert.notEqual(plan({ id: "ISS-2" }, history).branch, first.branch)
  assert.doesNotMatch(first.branch, /ISS-1/u)
  project.gitBranch.mode = "independent"
  const solo = plan({ id: "ISS-1" })
  assert.notEqual(plan({ id: "ISS-2", parentIssueId: "ISS-1" }, [{ ...history[0], gitBranch: solo }]).branch, solo.branch)
  project.gitBranch.mode = "continuous"
  assert.equal(plan({ id: "ISS-1" }).branch, plan({ id: "ISS-2" }).branch)
  project.gitBranch.create = false
  assert.equal(plan({ id: "ISS-1" }).branch, "main")
})

test("records the creation baseline and runs the agent on an isolated local branch", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-git-branch-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, "repo")
  await fs.mkdir(cwd)
  const git = async (...args) => (await execute("git", args, { cwd, windowsHide: true })).stdout.trim()
  await git("init", "--initial-branch=creation-branch")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "base")
  const initialHead = await git("rev-parse", "HEAD")
  await git("tag", "creation-branch")
  const config = await saveConfig(path.join(dir, "config.json"), { projects: [{ key: "project", path: cwd, gitBranch: {} }] }, dir)
  const project = config.projects[0]
  assert.deepEqual(project.gitBranch, { base: "creation-branch", create: true, mode: "auto" })
  assert.deepEqual(project.autoArchive, { enabled: false, days: 7 })
  await git("switch", "-c", "user-work")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "unrelated")
  const checkout = await readGitCheckout(cwd)
  const plan = { ...planGitBranch({ checkout, project, issue: { id: "issue" }, runs: [] }), gitBin: checkout.gitBin }
  const input = path.join(dir, "input.json")
  await fs.writeFile(input, JSON.stringify({ cwd, innerCodexHome: dir, codexBin: checkout.gitBin,
    args: ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "work"], gitCheckout: plan }))
  await execute(process.execPath, [fileURLToPath(target), input])
  assert.equal(await git("branch", "--show-current"), "user-work")
  assert.equal(await git("rev-parse", `${plan.branch}^`), initialHead)
  assert.equal(await git("log", "-1", "--format=%s", plan.branch), "work")
  const noNewBranch = await checkoutGitBranch({ ...plan, create: false, branch: project.gitBranch.base })
  assert.equal(await git("branch", "--show-current"), "creation-branch")
  await fs.writeFile(path.join(cwd, "ignored.txt"), "tracked on the baseline")
  await git("add", "ignored.txt")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "track file")
  assert.equal(await noNewBranch.restore(), true)
  await fs.appendFile(path.join(cwd, ".git", "info", "exclude"), "\nignored.txt\n")
  await fs.writeFile(path.join(cwd, "ignored.txt"), "local ignored file")
  await assert.rejects(checkoutGitBranch({ ...plan, create: false, branch: project.gitBranch.base }))
  assert.equal(await fs.readFile(path.join(cwd, "ignored.txt"), "utf8"), "local ignored file")
  await fs.writeFile(path.join(cwd, "untracked.txt"), "keep")
  await assert.rejects(execute(process.execPath, [fileURLToPath(target), input]), { code: GIT_CHECKOUT_REFUSED })
  assert.equal(await git("branch", "--show-current"), "user-work")
  assert.equal(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8"), "keep")
})

test("managed checkout can create a branch and commit inside the Windows sandbox", {
  skip: process.platform !== "win32" || process.env.WAUTO_WINDOWS_SANDBOX_LIVE_TEST !== "1",
}, async (t) => {
  const codex = await resolveExecutable("codex.exe")
  assert.ok(codex)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-git-branch-sandbox-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, "repo")
  const runDir = path.join(dir, "service", "run")
  const home = path.join(dir, "home")
  const temp = path.join(home, "tmp")
  await Promise.all([cwd, runDir, temp].map((file) => fs.mkdir(file, { recursive: true })))
  const git = async (...args) => (await execute("git", args, { cwd, windowsHide: true })).stdout.trim()
  const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"]
  await git("init", "--initial-branch=base")
  await git(...identity, "commit", "--allow-empty", "-m", "base")
  const { gitBin, repository } = await readGitCheckout(cwd)
  const input = path.join(runDir, "supervisor-input.json")
  const finalPath = path.join(runDir, "final.txt")
  await prepareCodexSandboxOutputs({ stage: "superpower", runDir, finalPath })
  await fs.writeFile(input, JSON.stringify({ cwd, innerCodexHome: home, codexBin: gitBin,
    args: [...identity, "commit", "--allow-empty", "-m", "work"],
    gitCheckout: { gitBin, repository, branch: "codex/test", base: "base", create: true },
  }))
  const launcherReadPaths = [fileURLToPath(target), ...["git-branch.mjs", "executable.mjs"].map((file) => fileURLToPath(new URL(file, import.meta.url))),
    ...await resolveExecutableReadPaths(gitBin), path.dirname(process.execPath)]
  const boundary = buildCodexPermissionBoundary({ stage: "superpower", cwd, projectPath: cwd,
    runtimeRoot: path.dirname(runDir), runDir, finalPath, runtimeWritePaths: [home], launcherReadPaths })
  const options = { boundary, cwd, targetBin: process.execPath, targetArgs: buildCodexSandboxTargetArgs(input) }
  await execute(codex, buildCodexSandboxArgs(options), { cwd, env: { ...buildCodexProcessEnv(process.env), HOME: home,
    USERPROFILE: home, CODEX_HOME: home, TMP: temp, TEMP: temp, TMPDIR: temp }, timeout: 45000, windowsHide: true })
  assert.equal(await git("branch", "--show-current"), "base")
  assert.equal(await git("log", "-1", "--format=%s", "codex/test"), "work")
})
