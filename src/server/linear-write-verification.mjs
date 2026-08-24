export function verifyLinearOperation({ operation, intent, issue } = {}) {
  if (operation?.type === "comment.create") {
    const resourceId = String(intent?.commentId || "").trim()
    const comment = (issue?.comments || []).find((item) => item?.id === resourceId)
    if (!comment) {
      return { status: "not-applied", resourceId }
    }
    if (comment.body !== operation.payload?.body) {
      return { status: "conflict", resourceId }
    }
    return { status: "verified", resourceId }
  }
  if (operation?.type === "issue.state.update") {
    const resourceId = String(intent?.state?.id || "").trim()
    const intendedName = String(intent?.state?.name || "").trim()
    const actualId = String(issue?.state?.id || "").trim()
    const actualName = String(issue?.state?.name || "").trim()
    if (actualId !== resourceId) {
      return { status: "not-applied", resourceId }
    }
    if (!resourceId || actualName !== intendedName || intendedName !== operation.payload?.state) {
      return { status: "conflict", resourceId }
    }
    return { status: "verified", resourceId }
  }
  return { status: "unsupported", resourceId: null }
}
