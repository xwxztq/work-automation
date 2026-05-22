export const PROJECT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PROJECT_KEY_MAX_LENGTH = 80

export function getProjectKeySafetyError(key: string) {
  const value = key.trim()
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

export function isSafeProjectKey(key: string) {
  return getProjectKeySafetyError(key) === null
}

export function generateProjectKey(existingKeys: Iterable<string> = []) {
  const usedKeys = new Set(existingKeys)
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const key = createUuidLikeKey()
    if (!usedKeys.has(key)) {
      return key
    }
  }
  throw new Error("无法生成唯一项目内部标识，请重试。")
}

function createUuidLikeKey() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }
  return `project-${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`
}

function randomHex(length: number) {
  const values = new Uint8Array(Math.ceil(length / 2))
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values)
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(values, (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length)
}
