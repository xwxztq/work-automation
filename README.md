<p align="center">
  <img src="public/WA-logo.png" alt="WorkAutomation logo" width="96" />
</p>

# Linear Codex 自动执行

本地服务，执行 Linear 到 Codex 的四阶段自动化流程。

- **阶段一**：扫描 `Todo / Needs Clarification / Too Large / Blocked`，Codex 做需求分析。
- **拆分阶段**：扫描 `Needs Splitting`，Codex 创建 parent/sub-issue、回写覆盖清单，父 issue 移到 `In Progress`。
- **阶段二**：扫描 `On Schedule`，Codex 实现代码；按 Linear 优先级（Urgent → Low）排序执行。
- **阶段三**：扫描 `Testing`，Codex 做 Auto Review，生成产物、上传附件，流转到 `Ready for Review` / `On Schedule` / `Blocked`。

服务端只负责扫描队列、启动独立 Codex supervisor、记录日志；Linear 评论和状态移动由 Codex agent 直接完成。多个项目并行，同一项目内各阶段互不等待，阶段二受并发上限控制。

其他行为要点：

- 状态流转不全自动：`Ready for Codex → On Schedule`、`Too Large → Needs Splitting` 需人工移动；不会自动移到 `Done`。
- 已处理 issue 的快照 MD5 存在 `.linear-automation/processed-issues.json`，无变化的 issue 自动跳过；手动指定 issue 不受跳过影响，但仍检查状态边界。
- 运行日志在 `.linear-automation/runs`，全局事件日志在 `.linear-automation/events.jsonl`；热重启后从运行记录恢复任务。

## Auto Review 协议

阶段三的输入、判定、基线和产物命名约定见 [docs/auto-review-protocol.md](docs/auto-review-protocol.md)。`part3Sandbox` 默认 `danger-full-access`，以便跨仓库把产物写回当前 run 目录。提示词模板在 `prompts/part1.global.md`、`split.global.md`、`part2.global.md`、`part3.global.md`。

## 快速开始

1. 安装依赖并准备本地配置：

   ```bash
   pnpm install
   cp config.example.json config.local.json
   cp .env.example .env.local
   ```

2. 在 `.env.local` 填写 `LINEAR_API_KEY`（不要写入 `config.local.json`；服务按 `.env.local` → `.env` 顺序加载，不覆盖已有环境变量）。

3. 在 Codex `config.toml` 中给 Linear MCP 工具配置审批权限（`save_issue`、`research`、`save_comment`、`prepare_attachment_upload`、`create_attachment_from_upload` 均设为 `approval_mode = "approve"`）。

4. 在 Linear 工作流中确认以下状态名，并与 `config.local.json` 的 `statuses` 保持一致：
   `Todo`、`Needs Clarification`、`Too Large`、`Needs Splitting`、`Blocked`、`Ready for Codex`、`On Schedule`、`In Progress`、`Testing`、`Ready for Review`。

5. 在界面或 `config.local.json` 中添加项目，必填字段：`repoName`、`linearProjectId`（Linear 项目 UUID）、`path`（仓库绝对路径）、`codexCwd`（默认同 `path`）、`branchOrScopePrefix`、`defaultTests`、`extraRules`（只写执行约束，不写密钥）。

6. 校验并启动：

   ```bash
   pnpm validate
   pnpm dev:all
   ```

   前端 `http://127.0.0.1:8888`，后端 `http://127.0.0.1:4378`。

## 运行方式

- 局域网访问：`pnpm dev:lan --host 192.168.1.23`（前后端和 `/api` proxy 使用同一 IP；不要用 `0.0.0.0`，换 IP 需重启）。
- 开发后端自带 watch，修改 `src/server` 自动重启，正在运行的 Codex 由独立 supervisor 恢复。
- 关闭前端轮询只停止扫描，不会停止已运行的 Codex 子进程。
- 生产模式：`pnpm build && pnpm start`，访问 `http://127.0.0.1:4378`；局域网用 `pnpm start:lan --host <IP>`。`--host` 优先级高于配置文件 `host`。

### Docker

```bash
./docker.sh up        # 构建并后台启动（restart: unless-stopped）
./docker.sh status / logs / restart / rebuild / down
```

容器复用仓库的 `config.local.json`、`prompts/`、`.linear-automation/`，挂载 `~/.codex`、`~/.gitconfig` 和项目目录（默认整个 `$HOME`，可用 `DEVELOPER_ROOT` 缩小范围；项目在 `$HOME` 外时必须显式指定）。容器内四阶段统一使用 `danger-full-access`，宿主机配置不受影响；Linear API key 通过 env 注入，不写入镜像。可用 `WORK_AUTOMATION_PORT` 改宿主机端口，`LOCAL_UID` / `LOCAL_GID` 适配非默认用户。需要 Xcode、macOS GUI 或其他语言工具链的项目请直接在宿主机运行。

## 配置

界面可配置：服务 ID、监听地址、端口、轮询间隔、Linear 密钥环境变量名（真实密钥只在 env 中）、Codex 命令与 sandbox（阶段一/拆分 `read-only`，阶段二/三 `danger-full-access`）、工作流状态名、各阶段成功/失败通知（系统通知 + 可选 Webhook，支持 `{IssueID}` 等 URL 模板变量）、项目与提示词。

执行事件在全局日志页查看，提示词在设置页维护。`config.local.json`、`.env.local`、`.env` 已被 gitignore，接口不返回密钥明文。
