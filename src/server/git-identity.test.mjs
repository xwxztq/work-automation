import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { isolatedGitIdentityConfig, resolveGitIdentityEnvironment } from "./git-identity.mjs"
import { resolveCodexExecutable, resolveExecutable } from "./executable.mjs"
import { buildCodexPermissionBoundary, buildCodexRuntimeReadPaths, buildCodexSandboxArgs } from "./codex-permissions.mjs"
import { buildCodexProcessEnv } from "./codex-environment.mjs"

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-git-identity-"))
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith("wa-git-identity-"))
    await fs.rm(root, { recursive: true, force: true })
  })
  const git = await resolveExecutable(process.platform === "win32" ? "git.exe" : "git")
  assert.ok(git)
  const project = path.join(root, "project")
  const globalConfig = path.join(root, "global.gitconfig")
  await fs.mkdir(project)
  await fs.writeFile(globalConfig, '[user]\nname = z-jack\nemail = identity@example.test\n[credential]\nhelper = PRIVATE_SENTINEL\n')
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_AUTHOR_NAME: "Codex", GIT_AUTHOR_EMAIL: "codex@local.invalid", GIT_COMMITTER_NAME: "Codex", GIT_COMMITTER_EMAIL: "codex@local.invalid" }
  const run = args => {
    const result = spawnSync(git, args, { cwd: project, env: environment, encoding: "utf8", windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  run(["init"])
  run(["config", "--local", "user.name", "Repository Bot"])
  run(["config", "--local", "user.email", "bot@example.test"])
  return { root, project, globalConfig, environment, git, run }
}

test("commits follow current global identity despite local and inherited bot identities", async t => {
  const f = await fixture(t)
  const identity = await resolveGitIdentityEnvironment({ cwd: f.project, environment: f.environment, required: true })
  assert.equal(identity.GIT_AUTHOR_NAME, "z-jack")
  assert.equal(identity.GIT_COMMITTER_EMAIL, "identity@example.test")
  const isolated = path.join(f.root, "isolated.gitconfig")
  const config = isolatedGitIdentityConfig(identity)
  assert.doesNotMatch(config, /PRIVATE_SENTINEL|credential/u)
  await fs.writeFile(isolated, config)
  const result = spawnSync(f.git, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "identity regression"], { cwd: f.project, env: { ...f.environment, ...identity, GIT_CONFIG_GLOBAL: isolated }, encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.run(["log", "-1", "--format=%an|%ae|%cn|%ce"]), "z-jack|identity@example.test|z-jack|identity@example.test")
  await fs.writeFile(f.globalConfig, '[user]\nname = Updated User\nemail = updated@example.test\n')
  assert.equal((await resolveGitIdentityEnvironment({ cwd: f.project, environment: f.environment, required: true })).GIT_AUTHOR_NAME, "Updated User")
})

test("missing global identity fails closed instead of falling back to Codex or repository config", async t => {
  const f = await fixture(t)
  await fs.writeFile(f.globalConfig, "[user]\nname = z-jack\n")
  await assert.rejects(resolveGitIdentityEnvironment({ cwd: f.project, environment: f.environment, required: true }), /Git 全局提交身份未配置完整/u)
  const optional = await resolveGitIdentityEnvironment({ cwd: f.project, environment: f.environment })
  assert.equal(optional.GIT_AUTHOR_EMAIL, "")
})

test("real Windows WA boundary preserves global author and committer", { skip: process.platform !== "win32" || process.env.WAUTO_GIT_IDENTITY_LIVE_TEST !== "1" }, async t => {
  const f = await fixture(t)
  const identity = await resolveGitIdentityEnvironment({ cwd: f.project, environment: f.environment, required: true })
  const codex = await resolveCodexExecutable("codex")
  assert.ok(codex)
  const home = path.join(f.root, "home")
  const temp = path.join(home, "tmp")
  const runDir = path.join(f.root, "service", "runs", "test")
  const codexHome = path.join(home, ".codex")
  await Promise.all([temp, codexHome, runDir].map(dir => fs.mkdir(dir, { recursive: true })))
  const config = path.join(home, ".gitconfig")
  await fs.writeFile(config, isolatedGitIdentityConfig(identity))
  const env = { ...buildCodexProcessEnv(process.env), ...identity, HOME: home, USERPROFILE: home, TMP: temp, TEMP: temp, TMPDIR: temp, CODEX_HOME: codexHome, GIT_CONFIG_GLOBAL: config }
  const boundary = buildCodexPermissionBoundary({ stage: "superpower", cwd: f.project, projectPath: f.project, runtimeRoot: path.join(f.root, "service"), runDir, runtimeWritePaths: [home], runtimeReadPaths: buildCodexRuntimeReadPaths(env), launcherReadPaths: [path.dirname(process.execPath), path.dirname(codex)] })
  const probe = `const fs=require('fs'),assert=require('assert/strict'),{spawnSync}=require('child_process');
    assert.throws(()=>fs.readFileSync(${JSON.stringify(f.globalConfig)}));
    const git=(args)=>{const r=spawnSync(${JSON.stringify(f.git)},args,{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
    assert.equal(git(['config','--global','--get','user.name']),'z-jack');
    git(['commit','--allow-empty','--no-gpg-sign','-m','sandbox identity regression']);
    assert.equal(git(['log','-1','--format=%an|%ae|%cn|%ce']),'z-jack|identity@example.test|z-jack|identity@example.test');
    console.log('IDENTITY_OK');`
  const result = spawnSync(codex, buildCodexSandboxArgs({ boundary, cwd: f.project, targetBin: process.execPath, targetArgs: ["-e", probe] }), { cwd: f.project, env, encoding: "utf8", windowsHide: true, timeout: 45000 })
  assert.equal(result.status, 0, `${result.error?.message || ""}\n${result.stderr}`)
  assert.match(result.stdout, /IDENTITY_OK/u)
})
