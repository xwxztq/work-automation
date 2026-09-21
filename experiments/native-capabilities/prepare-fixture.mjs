import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const output = process.argv[2]
if (!output || !path.isAbsolute(output)) throw new Error("Usage: node prepare-fixture.mjs <absolute-output-directory>")
const source = fileURLToPath(new URL("NativeCapabilityProbe.swift", import.meta.url))
const bundle = path.join(output, "NativeCapabilityProbe.app")
const binary = path.join(bundle, "Contents/MacOS/NativeCapabilityProbe")
await fs.mkdir(path.dirname(binary), { recursive: true })
await fs.writeFile(path.join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.workautomation.NativeCapabilityProbe</string>
<key>CFBundleExecutable</key><string>NativeCapabilityProbe</string>
<key>CFBundleName</key><string>NativeCapabilityProbe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`)
for (const [command, args] of [["/usr/bin/xcrun", ["swiftc", source, "-o", binary]], ["/usr/bin/codesign", ["--force", "--sign", "-", bundle]]]) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`)
}
console.log(JSON.stringify({ bundle, binary, outputFile: path.join(output, "recorded-value.json") }, null, 2))
