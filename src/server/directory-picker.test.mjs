import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createDirectoryPicker,
  DirectoryPickerUnavailableError,
} from "./directory-picker.mjs"

test("macOS directory picker reports capability and returns a validated absolute path", async () => {
  const calls = []
  const picker = createDirectoryPicker({
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    resolve: async (command) => command,
    run: async (executable, args) => {
      calls.push({ executable, args })
      return { stdout: "/Users/example/Projects/demo/\n" }
    },
    validate: async (selectedPath) => {
      assert.equal(selectedPath, "/Users/example/Projects/demo/")
      return "/Users/example/Projects/demo"
    },
  })

  assert.deepEqual(await picker.getCapability(), { available: true })
  assert.deepEqual(await picker.pickDirectory(), {
    status: "selected",
    path: "/Users/example/Projects/demo",
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, "/usr/bin/osascript")
  assert.deepEqual(calls[0].args.slice(0, 1), ["-e"])
})

test("Linux directory picker requires a graphical session and prefers zenity", async () => {
  let resolveCalls = 0
  const headless = createDirectoryPicker({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    resolve: async () => {
      resolveCalls += 1
      return "/usr/bin/zenity"
    },
  })

  assert.deepEqual(await headless.getCapability(), { available: false })
  assert.equal(resolveCalls, 0)
  await assert.rejects(() => headless.pickDirectory(), DirectoryPickerUnavailableError)

  const withoutSupportedPicker = createDirectoryPicker({
    platform: "linux",
    env: { PATH: "/usr/bin", DISPLAY: ":0" },
    resolve: async () => null,
  })
  assert.deepEqual(await withoutSupportedPicker.getCapability(), { available: false })

  const graphical = createDirectoryPicker({
    platform: "linux",
    env: { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" },
    resolve: async (command) => command === "zenity" ? "/usr/bin/zenity" : null,
    run: async (executable, args) => {
      assert.equal(executable, "/usr/bin/zenity")
      assert.deepEqual(args, ["--file-selection", "--directory", "--title=选择仓库目录"])
      return { stdout: "/srv/projects/demo\n" }
    },
    validate: async (selectedPath) => selectedPath,
  })

  assert.deepEqual(await graphical.getCapability(), { available: true })
  assert.deepEqual(await graphical.pickDirectory(), {
    status: "selected",
    path: "/srv/projects/demo",
  })
})

test("Linux directory picker falls back to kdialog", async () => {
  const resolved = []
  const picker = createDirectoryPicker({
    platform: "linux",
    env: { PATH: "/usr/bin", DISPLAY: ":0" },
    resolve: async (command) => {
      resolved.push(command)
      return command === "kdialog" ? "/usr/bin/kdialog" : null
    },
    run: async (executable, args) => {
      assert.equal(executable, "/usr/bin/kdialog")
      assert.deepEqual(args, ["--title", "选择仓库目录", "--getexistingdirectory"])
      return { stdout: "/home/example/project\n" }
    },
    validate: async (selectedPath) => selectedPath,
  })

  assert.deepEqual(await picker.pickDirectory(), {
    status: "selected",
    path: "/home/example/project",
  })
  assert.deepEqual(resolved, ["zenity", "kdialog"])
})

for (const cancellation of [
  { platform: "darwin", provider: "/usr/bin/osascript", stderr: "User canceled. (-128)" },
  { platform: "linux", provider: "/usr/bin/zenity", stderr: "" },
]) {
  test(`${cancellation.platform} directory picker treats user cancellation as a non-error result`, async () => {
    const error = Object.assign(new Error("picker exited"), {
      code: 1,
      stderr: cancellation.stderr,
    })
    const picker = createDirectoryPicker({
      platform: cancellation.platform,
      env: { PATH: "/usr/bin", DISPLAY: ":0" },
      resolve: async () => cancellation.provider,
      run: async () => {
        throw error
      },
    })

    assert.deepEqual(await picker.pickDirectory(), { status: "canceled" })
  })
}

test("directory picker surfaces execution failures instead of treating them as cancellation", async () => {
  const picker = createDirectoryPicker({
    platform: "linux",
    env: { PATH: "/usr/bin", DISPLAY: ":0" },
    resolve: async () => "/usr/bin/zenity",
    run: async () => {
      throw Object.assign(new Error("display connection failed"), {
        code: 2,
        stderr: "cannot open display",
      })
    },
  })

  await assert.rejects(() => picker.pickDirectory(), /目录选择器执行失败: cannot open display/)
})

test("directory picker validates that the selected path is an absolute readable directory", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-automation-picker-"))
  const filePath = path.join(rootDir, "file.txt")
  await fs.writeFile(filePath, "not a directory")
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))

  function pickerFor(stdout) {
    return createDirectoryPicker({
      platform: "darwin",
      resolve: async () => "/usr/bin/osascript",
      run: async () => ({ stdout }),
    })
  }

  assert.deepEqual(await pickerFor(`${rootDir}/\n`).pickDirectory(), {
    status: "selected",
    path: rootDir,
  })
  await assert.rejects(() => pickerFor("relative/project\n").pickDirectory(), /不是绝对路径/)
  await assert.rejects(() => pickerFor(`${filePath}\n`).pickDirectory(), /不是目录/)
  await assert.rejects(
    () => pickerFor(`${path.join(rootDir, "missing")}\n`).pickDirectory(),
    /不可读/,
  )
})
