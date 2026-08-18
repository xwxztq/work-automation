import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const COMPOSE_PATH = path.join(ROOT_DIR, "compose.yaml")
const DOCKER_SCRIPT_PATH = path.join(ROOT_DIR, "docker.sh")

test("developer bind mount defaults to the current host home", async () => {
  const composeSource = await readFile(COMPOSE_PATH, "utf8")

  assert.doesNotMatch(composeSource, /\/Users\/[A-Za-z0-9._-]+/)
  assert.match(composeSource, /source: "\$\{DEVELOPER_ROOT:-\$\{HOME\}\}"/)
  assert.match(composeSource, /target: "\$\{DEVELOPER_ROOT:-\$\{HOME\}\}"/)
})

test("Docker Compose resolves the default developer bind from HOME", (context) => {
  const fakeHome = "/tmp/work-automation-compose-home"
  const dockerConfig = process.env.DOCKER_CONFIG
    || (process.env.HOME ? path.join(process.env.HOME, ".docker") : undefined)
  const env = {
    ...process.env,
    HOME: fakeHome,
    ...(dockerConfig ? { DOCKER_CONFIG: dockerConfig } : {}),
  }
  delete env.DEVELOPER_ROOT

  const result = spawnSync("docker", ["compose", "config", "--no-env-resolution"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env,
  })
  if (
    result.error?.code === "ENOENT"
    || /unknown command: docker compose|is not a docker command/.test(result.stderr)
  ) {
    context.skip("Docker Compose is unavailable")
    return
  }

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout.includes(`source: ${fakeHome}`),
    true,
    "Compose must mount the current host home",
  )
  assert.equal(
    result.stdout.includes(`target: ${fakeHome}`),
    true,
    "Compose must preserve absolute host paths",
  )
})

test("docker helper defaults to HOME and rejects relative developer roots", async (context) => {
  const defaultEnv = { ...process.env, HOME: "/tmp", DOCKER_BIN: "/usr/bin/true" }
  delete defaultEnv.DEVELOPER_ROOT
  const defaultResult = spawnSync("bash", [DOCKER_SCRIPT_PATH, "validate"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: defaultEnv,
  })

  assert.equal(defaultResult.status, 0, defaultResult.stderr)
  assert.match(defaultResult.stdout, /项目挂载根目录: \/tmp/)

  await context.test("relative override", () => {
    const relativeResult = spawnSync("bash", [DOCKER_SCRIPT_PATH, "validate"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: { ...defaultEnv, DEVELOPER_ROOT: "projects" },
    })

    assert.equal(relativeResult.status, 1)
    assert.match(relativeResult.stderr, /DEVELOPER_ROOT 必须是绝对路径/)
  })
})
