// The Windows restricted-read sandbox permits opening an allowed descendant,
// but not lstat-ing each ancestor (including the drive root). Node's JS realpath
// implementation does the latter; its native implementation resolves the
// allowed target directly and still obeys the same OS permission boundary.
const preload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
if (process.platform === "win32") {
  fs.realpathSync = Object.assign(fs.realpathSync.native, { native: fs.realpathSync.native });
  fs.realpath = Object.assign(fs.realpath.native, { native: fs.realpath.native });
  syncBuiltinESMExports();
}
`

export function buildWindowsNodeOptions(platform = process.platform) {
  if (platform !== "win32") return undefined
  // An inline preload avoids needing to realpath a preload file before this
  // compatibility code is installed. Preserve normal dependency symlink resolution.
  return `--preserve-symlinks-main --import=data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`
}

export function formatNodeCommand(args, { platform = process.platform, execPath = process.execPath } = {}) {
  const quote = platform === "win32"
    ? value => `'${String(value).replaceAll("'", "''")}'`
    : value => `'${String(value).replaceAll("'", "'\\''")}'`
  return `${platform === "win32" ? "& " : ""}${[execPath, ...args].map(quote).join(" ")}`
}
