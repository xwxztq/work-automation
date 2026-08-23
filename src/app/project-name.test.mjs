import test from "node:test"
import assert from "node:assert/strict"

import {
  getInitialProjectNameSource,
  getLinearProjectSelectionUpdate,
  getProjectNameInputUpdate,
  getProjectNamePatchForPath,
} from "./project-name.ts"

const projectKey = "5a18714a-8bd5-4f69-8690-288d0ecc9790"
const linearProject = {
  id: "334ee61e-93f7-4b4b-be24-c48b0212aa35",
  name: "wa测试",
}

test("a new Linear project selection fills the visible name without changing the project key", () => {
  const project = { key: projectKey, repoName: "" }
  const result = getLinearProjectSelectionUpdate(project, linearProject, getInitialProjectNameSource(false))

  assert.deepEqual(result, {
    patch: {
      linearProjectId: linearProject.id,
      repoName: linearProject.name,
    },
    source: "linear",
  })
  assert.equal({ ...project, ...result.patch }.key, projectKey)
})

test("a repository path entered after Linear selection does not replace the Linear name", () => {
  const selection = getLinearProjectSelectionUpdate(
    { key: projectKey, repoName: "" },
    linearProject,
    getInitialProjectNameSource(false),
  )

  assert.deepEqual(getProjectNamePatchForPath("/Users/san/Projects/another-name", selection.source), {})
})

test("a manually entered name remains authoritative when selecting and reopening a project", () => {
  const manual = getProjectNameInputUpdate("本地自定义名称", "/Users/san/Projects/work-automation")
  const selected = getLinearProjectSelectionUpdate(
    { key: projectKey, repoName: manual.repoName },
    linearProject,
    manual.source,
  )
  const reopened = getLinearProjectSelectionUpdate(
    { key: projectKey, repoName: manual.repoName },
    linearProject,
    getInitialProjectNameSource(true),
  )

  assert.deepEqual(selected, {
    patch: { linearProjectId: linearProject.id },
    source: "manual",
  })
  assert.deepEqual(reopened, selected)
})

test("reselecting while the name comes from Linear uses the newly selected project name", () => {
  const first = getLinearProjectSelectionUpdate(
    { key: projectKey, repoName: "" },
    { id: "linear-a", name: "项目 A" },
    getInitialProjectNameSource(false),
  )
  const second = getLinearProjectSelectionUpdate(
    { key: projectKey, repoName: first.patch.repoName },
    { id: "linear-b", name: "项目 B" },
    first.source,
  )

  assert.deepEqual(second, {
    patch: { linearProjectId: "linear-b", repoName: "项目 B" },
    source: "linear",
  })
})

test("reselecting a legacy project whose visible name equals its key restores the Linear name", () => {
  const result = getLinearProjectSelectionUpdate(
    { key: projectKey, repoName: projectKey },
    linearProject,
    getInitialProjectNameSource(true),
  )

  assert.deepEqual(result, {
    patch: {
      linearProjectId: linearProject.id,
      repoName: linearProject.name,
    },
    source: "linear",
  })
})

test("clearing a manual name returns name updates to repository-path derivation", () => {
  assert.deepEqual(getProjectNameInputUpdate("   ", "/Users/san/Projects/work-automation/"), {
    repoName: "work-automation",
    source: "path",
  })
  assert.deepEqual(getProjectNamePatchForPath("C:\\Projects\\linear-automation\\", "path"), {
    repoName: "linear-automation",
  })
})
