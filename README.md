<p align="center">
  <img src="https://raw.githubusercontent.com/xwxztq/work-automation/main/public/WA-logo.png" alt="WorkAutomation logo" width="96" />
</p>

# Linear Codex 自动执行

本地服务，执行 Linear 到 Codex 的四阶段自动化流程。

- **阶段一**：扫描 `Todo / Needs Clarification / Too Large / Blocked`，Codex 做需求分析并输出结构化事项操作。
- **拆分阶段**：扫描 `Needs Splitting`，Codex 规划 parent/sub-issue、覆盖清单和目标状态操作。
- **阶段二**：扫描 `On Schedule`，Codex 实现代码、测试并提交，再输出完成或阻塞操作；按 Linear 优先级（Urgent → Low）排序执行。
- **阶段三**：扫描 `Testing`，Codex 做 Auto Review、生成产物，并输出附件、评论和状态操作。

服务端读取候选事项并提供不可变快照，启动独立 Codex supervisor，再按 [Agent 结构化结果协议](docs/agent-result-protocol.md) 校验和保存 `final.txt`。Codex 子进程不接收 Linear API key，也不加载用户级 Linear MCP 配置。当前版本尚不执行结果中的 operations；评论、状态、子事项和附件需要后续受控执行器接入。多个项目并行，同一项目内各阶段互不等待，阶段二受并发上限控制。

其他行为要点：

- 状态流转不全自动：`Ready for Codex → On Schedule`、`Too Large → Needs Splitting` 需人工移动；不会自动移到 `Done`。
- 已处理 issue 的快照 MD5 存在 `.linear-automation/processed-issues.json`，无变化的 issue 自动跳过；手动指定 issue 不受跳过影响，但仍检查状态边界。
- 运行日志在 `.linear-automation/runs`，全局事件日志在 `.linear-automation/events.jsonl`；热重启后从运行记录恢复任务。

## Auto Review 协议

阶段三的输入、判定、基线和产物命名约定见 [docs/auto-review-protocol.md](docs/auto-review-protocol.md)。`part3Sandbox` 默认 `danger-full-access`，以便跨仓库把产物写回当前 run 目录。提示词模板在 `prompts/part1.global.md`、`split.global.md`、`part2.global.md`、`part3.global.md`。

## npm 安装（推荐）

npm 包不包含 Node、pnpm、前端源码和测试文件。用户需要先安装 Node 22 或更高版本以及 Codex，然后运行：

```bash
npm install -g @xwxztq/work-automation
wauto setup
```

`setup` 在 macOS 上注册用户级 LaunchAgent `com.workautomation.agent`，启动服务并打开首次配置页面。首次配置会校验 Linear API key、查找 Codex，并在配置完成前阻止后台扫描和手动执行。用户数据保存在 `~/Library/Application Support/WorkAutomation/data`，不会写进 npm 全局安装目录。

常用命令：

```bash
wauto open
wauto service status
wauto service start
wauto service stop
wauto service uninstall
```

升级 npm 包后，如果 Node 的安装路径发生了变化，需要重新执行 `wauto setup` 更新 LaunchAgent。卸载前先运行 `wauto service uninstall`，再执行 `npm uninstall -g @xwxztq/work-automation`。

Windows 和 Linux 当前可以使用 `wauto serve` 前台运行；用户级后台服务注册仍待实现。`wauto once` 和 `wauto validate` 在三个平台使用同一套 Node 后端。

维护者可生成待发布的 npm 压缩包：

```bash
npm run npm:pack
```

产物写入 `artifacts/npm`。打包前会重新构建前端，npm 发布清单只保留 `dist`、服务端运行文件、提示词、文档和 `https-proxy-agent` 运行依赖。实际发布前应更新 `package.json` 版本并检查 npm scope 权限。

### 从 main 自动发布 npm 包

`.github/workflows/publish-npm.yml` 只监听 `main` 分支的 push，不响应其他分支或 pull request。`package.json` 的版本号是发布开关：合入 `main` 前必须更新为 npm Registry 中尚未使用的版本。workflow 会先查询 `@xwxztq/work-automation@<version>`；版本已存在时记录跳过原因并成功结束，版本不存在时才安装锁定依赖、运行测试和构建、检查包内容并公开发布。并发运行会串行处理，后执行的相同版本会在查询阶段跳过。

首次发布新版本前，按照 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/) 在 npm 包的 **Settings → Trusted publishing** 中新增 GitHub Actions 发布者：

- Organization or user：`xwxztq`
- Repository：`work-automation`
- Workflow filename：`publish-npm.yml`（只填文件名）
- Environment name：留空
- Allowed actions：`npm publish`

workflow 固定使用 Node 24.19.0、npm 11.17.0 和仓库声明的 pnpm 11.2.2。发布鉴权来自 GitHub-hosted runner 的 `id-token: write` 权限和 npm Trusted Publishing 的短期 OIDC 凭据，不读取 `NPM_TOKEN`、npm 密码或一次性验证码。npm 账户可以继续启用二次验证；首次 OIDC 发布成功后，可在 Publishing access 中选择要求二次验证并禁用传统 token。若每个版本都必须人工批准，应改用 npm staged publishing，并把 Trusted Publisher 的权限和 workflow 命令一起改为 `npm stage publish`，不能继续使用这里的直接发布命令。

## 从源码运行

1. 安装依赖并准备本地配置：

   ```bash
   pnpm install
   cp config.example.json config.local.json
   cp .env.example .env.local
   ```

2. 在 `.env.local` 填写 `LINEAR_API_KEY`（不要写入 `config.local.json`；服务按 `.env.local` → `.env` 顺序加载，不覆盖已有环境变量）。

3. 确认 Codex CLI 支持 `exec --ignore-user-config`、`--output-schema` 和 `--output-last-message`。自动化运行不会加载用户 `config.toml`，不需要配置 Linear MCP。

4. 在 Linear 工作流中确认以下状态名，并与 `config.local.json` 的 `statuses` 保持一致：
   `Todo`、`Needs Clarification`、`Too Large`、`Needs Splitting`、`Blocked`、`Ready for Codex`、`On Schedule`、`In Progress`、`Testing`、`Ready for Review`。

5. 在界面或 `config.local.json` 中添加项目，必填字段：`repoName`、`linearProjectId`（Linear 项目 UUID）、`path`（仓库绝对路径）、`codexCwd`（默认同 `path`）、`branchOrScopePrefix`、`defaultTests`、`extraRules`（只写执行约束，不写密钥）。

   项目编辑器中的仓库路径始终可以手工填写。macOS 会使用系统目录选择窗口；Linux 仅在图形会话中且 `PATH` 内存在 `zenity` 或 `kdialog` 时显示“选择”按钮。选择的是运行 WorkAutomation 服务的机器上的目录。能力不可用或选择器启动失败时按钮会隐藏，页面不显示错误，失败详情只写入浏览器控制台。

6. 校验并启动：

   ```bash
   pnpm validate
   pnpm dev:all
   ```

   前端 `http://127.0.0.1:8888`，开发后端 `http://127.0.0.1:4379`。安装版和生产模式继续使用 `4378`，可与源码开发同时运行。

## 运行方式

- 局域网访问：`pnpm dev:lan --host 192.168.1.23`（前后端和 `/api` proxy 使用同一 IP；不要用 `0.0.0.0`，换 IP 需重启）。
- 开发后端自带 watch，修改 `src/server` 自动重启，正在运行的 Codex 由独立 supervisor 恢复；恢复路径仍会重新校验结构化结果，不能仅凭非空 `final.txt` 标记成功。
- 关闭前端轮询只停止扫描，不会停止已运行的 Codex 子进程。
- 生产模式：`pnpm build && pnpm start`，访问 `http://127.0.0.1:4378`；局域网用 `pnpm start:lan --host <IP>`。`--host` 优先级高于配置文件 `host`。

### 无需 Node 的 macOS 原生包（备用）

原生包适合不希望单独安装 Node 的用户，不要求预装 Node 或 pnpm。构建命令会下载与构建机 Node 版本一致的官方 macOS 运行时，按照 Node 发布页的 `SHASUMS256.txt` 校验后放入发布包：

```bash
pnpm native:bundle:macos
```

产物位于 `artifacts/native/work-automation-darwin-arm64` 或 `work-automation-darwin-x64`。用户解压后双击 `install.command`，安装器会把程序复制到 `~/Library/Application Support/WorkAutomation/app/<版本>`，注册用户级 LaunchAgent `com.workautomation.agent`，启动服务并打开首次配置页面。首次配置会：

- 调用 Linear API 校验密钥，再写入用户数据目录下的 `.env.local`，文件权限为 `0600`；
- 自动查找终端、ChatGPT 应用和常见安装目录中的 Codex，并把绝对路径保存到配置；
- 在密钥和 Codex 都可用前阻止后台扫描与手动执行。

配置、提示词、运行记录和日志与程序版本分开，统一保存在 `~/Library/Application Support/WorkAutomation/data`。升级程序不会覆盖这些数据。服务管理命令在发布包的 `bin/wauto`：

```bash
bin/wauto status
bin/wauto start
bin/wauto stop
bin/wauto open
bin/wauto uninstall
```

`uninstall` 只移除 LaunchAgent 注册，保留用户数据和已安装程序。阶段一尚未包含 Apple Developer ID 签名、公证、自动更新以及 Windows/Linux 安装器，因此当前产物适合内部测试，不应直接作为公开下载版本。

只做本机构建链路冒烟时，可运行 `pnpm native:bundle:macos:local`。它复制本机 Node 及所需运行库，不具备跨机器可移植性。

## 配置

界面可配置：服务 ID、监听地址、端口、轮询间隔、Linear 密钥环境变量名（真实密钥只在 env 中）、Codex 命令与 sandbox（阶段一/拆分 `read-only`，阶段二/三 `danger-full-access`）、工作流状态名、各阶段成功/失败通知（系统通知 + 可选 Webhook，支持 `{IssueID}` 等 URL 模板变量）、项目与提示词。

执行事件在全局日志页查看，提示词在设置页维护。`config.local.json`、`.env.local`、`.env` 已被 gitignore，接口不返回密钥明文。
