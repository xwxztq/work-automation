export function resolveExecutionMode(config, project = {}) {
  const globalMode = config.codex?.executionMode ?? "sandbox"
  const projectMode = project.executionMode ?? "inherit"
  if (!["sandbox", "native"].includes(globalMode)) {
    throw new Error("codex.executionMode 必须是 sandbox 或 native。")
  }
  if (!["inherit", "sandbox", "native"].includes(projectMode)) {
    throw new Error("project.executionMode 必须是 inherit、sandbox 或 native。")
  }
  return projectMode === "inherit" ? globalMode : projectMode
}

export function executionModeGuidance(mode, stage) {
  if (mode !== "native") return ""
  const scope = stage === "part2"
    ? "仅修改本任务授权的代码并运行相关构建和测试。"
    : "本阶段仍只分析或审查业务代码；不得修改业务源码或创建提交，构建和测试产物应放在临时目录。"
  return `\n执行环境：本机执行模式。\n- 保留服务账号的本机 HOME、开发工具链、Codex 用户配置、规则和已启用插件。WorkAutomation 不添加外层文件沙箱；命令权限请求由 Codex 自动审批处理，不绕过审批。\n- ${scope}本机配置不扩大任务授权范围。\n- 不得读取事项平台凭据或直接调用事项平台，包括用户配置中可能启用的事项平台 MCP；仍只输出服务规定的操作意图。\n- 如实际工具目录提供 Computer Use，可按其文档操作本任务授权的应用。工具缺失或权限被拒绝时如实报告；不得以其他浏览器或桌面技术冒充验收。网页浏览器不能操作 AppKit 原生窗口。\n`
}
