import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { loadLocalEnv, parseEnvContent, writeLocalEnvValue } from "./env.mjs"

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linear-automation-env-"))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("parses basic env file syntax", () => {
  assert.deepEqual(
    parseEnvContent(`
# comment
LINEAR_API_KEY=abc123
EMPTY=
export QUOTED="hello world"
SINGLE='literal value'
INLINE=value # ignored comment
HASH=value#kept
MULTILINE="line\\nnext"
QUOTED_COMMENT="value # kept" # ignored comment
`),
    {
      LINEAR_API_KEY: "abc123",
      EMPTY: "",
      QUOTED: "hello world",
      SINGLE: "literal value",
      INLINE: "value",
      HASH: "value#kept",
      MULTILINE: "line\nnext",
      QUOTED_COMMENT: "value # kept",
    },
  )
})

test("loads .env.local before .env without overwriting values from earlier files", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".env"), "LINEAR_API_KEY=from-env\nFALLBACK=from-env\n")
    await fs.writeFile(
      path.join(dir, ".env.local"),
      "LINEAR_API_KEY=from-local\nLOCAL_ONLY=1\n",
    )

    const env = {}
    const loaded = await loadLocalEnv(dir, { env })

    assert.equal(env.LINEAR_API_KEY, "from-local")
    assert.equal(env.FALLBACK, "from-env")
    assert.equal(env.LOCAL_ONLY, "1")
    assert.deepEqual(
      loaded.map((item) => item.file),
      [".env.local", ".env"],
    )
  })
})

test("does not overwrite existing environment variables", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".env.local"), "LINEAR_API_KEY=from-file\n")

    const env = { LINEAR_API_KEY: "from-shell" }
    const loaded = await loadLocalEnv(dir, { env })

    assert.equal(env.LINEAR_API_KEY, "from-shell")
    assert.deepEqual(loaded[0].skipped, ["LINEAR_API_KEY"])
  })
})

test("ignores missing local env files", async () => {
  await withTempDir(async (dir) => {
    const env = {}

    assert.deepEqual(await loadLocalEnv(dir, { env }), [])
    assert.deepEqual(env, {})
  })
})

test("writes a private local env value without changing unrelated entries", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".env.local"),
      "UNCHANGED=yes\nLINEAR_API_KEY=old\nLINEAR_API_KEY=duplicate\n",
    )

    const filePath = await writeLocalEnvValue(dir, "LINEAR_API_KEY", 'new "token"')
    const content = await fs.readFile(filePath, "utf8")
    const stat = await fs.stat(filePath)

    assert.match(content, /^UNCHANGED=yes$/m)
    assert.equal((content.match(/LINEAR_API_KEY=/g) || []).length, 1)
    assert.equal(parseEnvContent(content).LINEAR_API_KEY, 'new "token"')
    assert.equal(stat.mode & 0o777, 0o600)
  })
})
