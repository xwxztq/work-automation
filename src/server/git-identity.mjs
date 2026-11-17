import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveExecutable } from "./executable.mjs"

const execute = promisify(execFile)

export async function resolveGitIdentityEnvironment({ cwd, environment = process.env, required = false }) {
  const git = await resolveExecutable(process.platform === "win32" ? "git.exe" : "git", {
    cwd, path: environment.PATH || environment.Path,
  })
  const read = async key => {
    if (!git) return ""
    try {
      const { stdout } = await execute(git, ["config", "--global", "--includes", "--get", key], {
        cwd, env: environment, windowsHide: true, timeout: 5000, maxBuffer: 4096,
      })
      const value = stdout.trim()
      return /[\r\n\0]/u.test(value) ? "" : value
    } catch { return "" }
  }
  const [name, email] = await Promise.all([read("user.name"), read("user.email")])
  if (required && (!name || !email)) {
    throw new Error("Git 全局提交身份未配置完整。请在 WA 宿主设置 git config --global user.name 和 user.email；不会使用 Codex 或占位作者创建提交。")
  }
  // Global settings are the user's chosen source of truth. Clear inherited
  // automation identities too, rather than silently falling back to them.
  return { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email }
}

export function isolatedGitIdentityConfig(environment) {
  const name = environment.GIT_AUTHOR_NAME || ""
  const email = environment.GIT_AUTHOR_EMAIL || ""
  return `[user]\n\tuseConfigOnly = true\n${name ? `\tname = ${JSON.stringify(name)}\n` : ""}${email ? `\temail = ${JSON.stringify(email)}\n` : ""}`
}
