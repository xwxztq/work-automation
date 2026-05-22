export const PROJECT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PROJECT_KEY_MAX_LENGTH = 80

export function projectKeySafetyError(key) {
  const value = String(key || "").trim()
  if (!value) {
    return "项目内部标识不能为空。"
  }
  if (value.length > PROJECT_KEY_MAX_LENGTH) {
    return `项目内部标识不能超过 ${PROJECT_KEY_MAX_LENGTH} 个字符。`
  }
  if (!PROJECT_KEY_PATTERN.test(value)) {
    return "项目内部标识只能包含小写字母、数字和连字符，并且不能以连字符开头或结尾。"
  }
  return null
}

export function isSafeProjectKey(key) {
  return projectKeySafetyError(key) === null
}

export function validateProjectKeys(projects, { previousProjects = [], allowUnsafeExisting = false } = {}) {
  const errors = []
  const warnings = []
  const keys = new Set()
  const previousKeys = new Set(
    previousProjects
      .map((project) => String(project?.key || "").trim())
      .filter(Boolean),
  )

  for (const [index, project] of projects.entries()) {
    const key = String(project?.key || "").trim()
    const label = key || `projects[${index}]`

    if (!key) {
      errors.push(`第 ${index + 1} 个项目缺少 key。`)
      continue
    }
    if (keys.has(key)) {
      errors.push(`项目 key 重复: ${key}`)
      continue
    }
    keys.add(key)

    const safetyError = projectKeySafetyError(key)
    if (!safetyError) {
      continue
    }
    if (allowUnsafeExisting && previousKeys.has(key)) {
      warnings.push(`${label}: 当前使用旧格式项目 key，已兼容保留，不会自动重命名。`)
      continue
    }
    errors.push(`${label}: ${safetyError}`)
  }

  return { errors, warnings }
}
