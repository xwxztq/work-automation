import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export function inspectPackageArchive(bytes) {
  const tar = gunzipSync(bytes)
  const files = new Map()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (a, b) => header.subarray(a, b).toString().replace(/\0.*$/su, "")
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/")
    const size = parseInt(field(124, 136).trim(), 8)
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("Invalid package archive")
    if (!["0", "\0", "5"].includes(field(156, 157) || "\0")) throw new Error(`Unexpected archive entry: ${name}`)
    if (name.includes("..") || /(?:^|\/)(?:\.env[^/]*|config\.local\.json|auth\.json|\.npmrc|\.linear-automation|node_modules|\.git)(?:\/|$)/u.test(name)) throw new Error(`Private package entry: ${name}`)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (/\b(?:lin_api_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{24,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(body.toString())) throw new Error(`Credential-like content: ${name}`)
    files.set(name.replace(/^package\//u, ""), body)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  for (const name of ["dist/index.html", "config.example.json", "docs/agent-result-protocol.md", "docs/centralized-linear-migration.md", ...["part1", "split", "part2", "part3"].map((stage) => `prompts/${stage}.global.md`), ...["agent-result-protocol", "agent-result-runtime", "issue-audit", "diagnostic-redaction", "issue-operation-executor", "run-images", "linear-read-adapter", "linear-write-adapter", "native-service-cli", "browser-client", "browser-session"].map((name) => `src/server/${name}.mjs`)]) {
    if (!files.has(name)) throw new Error(`Missing runtime file: ${name}`)
  }
  if ([...files.keys()].some((name) => name.endsWith(".test.mjs") || name.includes("linear-auth-diagnostics"))) throw new Error("Obsolete diagnostics or tests included")
  return { files: files.size, bytes: bytes.length }
}

export async function checkNpmPackage(root) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wauto-package-"))
  try {
    const packed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--ignore-scripts", "--json", "--cache", path.join(dir, "cache"), "--pack-destination", dir], { cwd: root, encoding: "utf8" })
    if (packed.status !== 0) throw new Error("npm pack failed")
    const [{ filename }] = JSON.parse(packed.stdout)
    return inspectPackageArchive(await fs.readFile(path.join(dir, path.basename(filename))))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkNpmPackage(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))))
}
