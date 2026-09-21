# WorkAutomation 从 Linear 发起 Computer Use 的实测

日期：2026-09-21。

测试事项：[LIV-1208](https://linear.app/livehappy-workhappy/issue/LIV-1208)，项目“wa测试”。首次测试因 runner 清空用户配置和 MCP 而阻塞；修复后的重测通过真实 Chrome 交互与服务 Linear 写回。以下保留两次运行的证据。

## 首次测试范围

常驻服务运行已安装的 0.2.0 包，监听 4378；配置中没有“wa测试”项目。为避免改动其其他业务项目，本次从当前源码启动独立测试实例，监听 4391，只映射“wa测试”到隔离 Git 工作区，使用项目级 `executionMode: native`。首次测试没有修改 runner 或插件配置，也没有部署/替换常驻服务。

通过标准 `POST /api/runs/issue` 提交 `stage: part2`、`issueId: LIV-1208` 及测试 projectKey。服务实际读取 Linear 快照、执行 scheduler、启动 supervisor 和 Codex，并通过服务端集中写入协议回写结果。不是独立手工执行 CLI 替代 WorkAutomation。

## 证据

- Run ID：`2026-09-21T03-42-52-720Z-f04a1ddd-3b0b-48e2-b5d9-c135fa229587-part2-LIV-1208-75f9328c`。
- CLI：`/Users/san/.bun/bin/codex`，已核对版本 0.155.1。
- `executionMode: native`，`codexStarted: true`，`exitCode: 0`。
- 实际参数仍有 `--ignore-user-config`、`--ignore-rules`、`--ephemeral`、`--dangerously-bypass-approvals-and-sandbox`、`-c mcp_servers={}`。
- 任务报告没有 `cua_repl`，因此按验收要求停止；未操作 Chrome，未产生新作品、截图或任务提交，也未用其他浏览器工具代替。
- `comment.create` 和 `issue.state.update` 均为 `verified`。独立 Linear 回读确认评论存在，事项从 On Schedule 进入 Blocked。
- Run 的 `succeeded` 表示 Codex 正常退出且结构化结果成功执行；业务结果是 Blocked，不能把它当成 GUI 测试通过。

## 与先前普通 exec 成功实验的差异

先前普通 `codex exec` 保留本机用户配置并加载 `unified-computer-use`，Chrome 导航、点击换色和保存均成功。本次 WorkAutomation 即使选本机模式，仍统一忽略用户配置并清空 MCP。源码位置为 `src/server/codex-runner.mjs` 的 `buildCodexArgs`。

因此本机执行权限与 Computer Use 插件加载是两项不同条件。解除本次阻塞需要调整本机分支的配置/插件加载及审批处理，再从同一 Linear 测试事项重跑。首次测试没有进行这一产品行为变更。后续修复和重测见下文。

详细记录：`/Users/san/Projects/Infra/linear/linear-automation/.linear-automation/computer-use-linear-20260921/verification.json`。原始运行产物：`/Users/san/Projects/Infra/linear/linear-automation/.linear-automation/computer-use-linear-20260921/runtime/.linear-automation/runs/2026-09-21T03-42-52-720Z-f04a1ddd-3b0b-48e2-b5d9-c135fa229587-part2-LIV-1208-75f9328c`。


## 修复及重测

本机分支不再传 `--ignore-user-config`、`--ignore-rules`、`mcp_servers={}` 或 bypass 参数，保留本机用户配置和启用的插件。改用 `--approve-for-me`，并以 `--add-dir` 授权写入本次 run 的产物目录。继续使用 `--ephemeral`、结构化输出 schema、环境变量过滤和服务集中写回。默认沙箱模式的参数不变。

重测仍从同一个 Linear 事项和标准 `/api/runs/issue` 接口发起，使用源码测试实例 4391。

- Run ID：`2026-09-21T03-55-38-929Z-f04a1ddd-3b0b-48e2-b5d9-c135fa229587-part2-LIV-1208-982c0dad`。
- 本机 supervisor PID 24262，Codex PID 24263；任务内只读进程祖先检查也命中同一 supervisor。
- 实际调用 `cua_repl.js` 的 `cua.createBrowserTab("chrome", ...)`、`tab.click`、`tab.getAXState`、`tab.getScreenshot` 和 `tab.close`。
- Chrome extension 后端创建专属标签，选择“薄荷绿”并点击“保存这张作品”；页面显示“已保存：codex-buddy.svg · 薄荷绿”。
- 落盘 `codex-buddy.svg` 中背带裤填充为 `#90cbb5`；将该属性恢复后与初始 SVG 的解析结果一致。
- 原始截图 `LIV-1208-saved.jpg` 为 1539 × 854，80548 字节；人工查看显示选中的薄荷绿、对应背带裤和保存提示。
- 测试工作区提交 `cde67178052e4ebba539300ed7eb0b9ce579abc0` 仅包含五个验收产物，没有提交或推送主仓库修复。
- 任务已关闭自建 Chrome 标签并停止本地预览服务。

产物在 `.linear-automation/computer-use-linear-20260921/workspace/`，包含原始截图、SVG、页面状态、保存记录和 `evidence.json`。原始调用日志位于上述 run 的 `stdout.jsonl`。

### Linear 写回结果

重测退出码为 0，run 状态 `succeeded`，事项操作状态 `completed`。服务创建评论 `3dd45115-8b0e-4e91-8af7-5fb790cbdf4f` 并将事项移到 `Testing`；两项操作均为 `verified`。独立 Linear API 回读也确认新评论及 `Testing` 状态。这是阶段二验收结果，未运行阶段三 Auto Review。

机器可读核对记录：`.linear-automation/computer-use-linear-20260921/verification-retest.json`，独立平台回读：`linear-retest-readback.json`。

### 回归检查及范围

- 四个阶段的本机进程集成测试通过，检查用户工具保留、自动审批参数、结构化协议、父任务环境及服务凭据过滤。
- 改动文件 ESLint、TypeScript 构建、Vite 生产构建通过。
- 宿主全量测试：283 个，280 通过、2 失败、1 跳过。失败为 `scheduler.test.mjs` 中两个事项操作重试用例；在临时目录解包未修改的 `HEAD` 后，单独运行该文件同样得到 13 通过、2 失败，故属于既有失败。本次没有修改调度器。
- 本轮证明 WorkAutomation 本机任务可自主使用现有 Computer Use 插件完成 Chrome 操作，不代表所有 AppKit、IAB、并发桌面操作都已验收。
- 此修复未发布 npm，也没有替换监听 4378 的已安装 0.2.0 常驻服务。
