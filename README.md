<p align="center">
  <img src="public/WA-logo.png" alt="WorkAutomation logo" width="96" />
</p>

# Linear Codex 自动执行

本地服务，用于在每台服务器上执行 Linear 到 Codex 的四阶段流程（阶段一、拆分阶段、阶段二、阶段三）。

## 功能

- 读取当前机器配置的 Linear 项目。
- 阶段一检测 `Todo / Needs Clarification / Too Large / Blocked` 并启动 Codex 做分析。
- 拆分阶段检测 `Needs Splitting` 并启动 Codex 创建 parent/sub-issue 子事项、回写覆盖清单，并把父 issue 移到 `In Progress`。
- 阶段二检测 `On Schedule` 并启动 Codex 做实现；候选按 Linear 优先级语义排序：`Urgent`、`High`、`Medium`、`Low`、无优先级，同优先级按 issue 编号数字升序执行。
- 阶段三检测 `Testing` 并启动 Codex 做 Auto Review，按协议生成 review 产物、上传关键附件到 Linear，并流转到 `Ready for Review`、`On Schedule` 或 `Blocked`。
- 服务端只负责扫描队列、启动独立 Codex supervisor、记录日志和停止子进程；Linear 评论和状态移动由 Codex agent 直接完成。
- 多个项目并行执行；同一项目内阶段一、拆分阶段、阶段二、阶段三互不等待，阶段一不同 issue 可并行执行，阶段二仍受并发上限控制。
- 使用 `codex exec --json --skip-git-repo-check --sandbox <stage sandbox> -C <project.codexCwd> -` 启动 Codex。
- 支持停止单个运行或当前项目的运行；后端热重启后会从 `.linear-automation/runs` 恢复仍在运行的任务。
- 单次运行日志写入 `.linear-automation/runs`，全局执行日志写入 `.linear-automation/events.jsonl`。
- 已处理 issue 的快照 MD5 写入 `.linear-automation/processed-issues.json`。自动扫描时，如果当前 Linear issue 自上次处理后没有变化，会跳过，避免 Blocked 等状态被重复评论；手动指定 issue 执行不受这个跳过规则影响，但仍会遵守阶段状态边界。
- 手动指定 issue 且选择 `全部` 时，服务端会按 issue 当前状态只路由到一个合法阶段：`Todo / Needs Clarification / Too Large / Blocked` 进入阶段一，`Needs Splitting` 进入拆分阶段，`On Schedule` 进入阶段二，`Testing` 进入阶段三，其他状态直接跳过。
- 不自动移动 issue 到 `Done`。

## Auto Review 协议

- 阶段三输入、成功 / 失败判定、基线来源和产物命名约定见 [docs/auto-review-protocol.md](docs/auto-review-protocol.md)。
- 阶段三评论在保留 `Review 摘要` / `关键产物内容` 内联结论的同时，需要把适合直接审阅的关键截图或对比产物上传到 Linear，并在评论中引用这些附件。
- 当前仓库固定提供的运行基础文件来自 `.linear-automation/runs/<run-id>/`，阶段三后续新增的 review 产物也统一落在当前 `part3` run 目录下。
- 为了让跨仓库的阶段三可以把 review 产物写回当前 Work Automation 的 run 目录，默认 `part3Sandbox` 使用 `danger-full-access`；提示词会约束 agent 只写当前 run 目录，不回写业务仓库。
- 阶段一、拆分阶段、阶段二和阶段三的提示词模板分别位于 `prompts/part1.global.md`、`prompts/split.global.md`、`prompts/part2.global.md` 与 `prompts/part3.global.md`。

## 首次使用

先按顺序完成配置，再启动服务，避免 Codex agent 因缺少 Linear 权限或状态配置而中途失败。

1. 安装依赖:

   ```bash
   pnpm install
   ```

2. 复制本地配置文件和本地 env 文件:

   ```bash
   cp config.example.json config.local.json
   cp .env.example .env.local
   ```

3. 在 `.env.local` 中填写 Linear API key，不要写入 `config.local.json`:

   ```dotenv
   LINEAR_API_KEY=你的 Linear API key
   ```

   `.env.local` 和 `.env` 已加入 `.gitignore`，不会被追踪；`.env.example` 只保留空占位，不要写入真实密钥。服务启动时会按 `.env.local`、`.env` 的顺序加载本地 env 文件，并且不会覆盖当前 shell 或进程里已经存在的同名环境变量。

   如果改用其他环境变量名，需要同步修改 `linear.apiKeyEnv`，并在 `.env.local` 中使用同一个变量名。

4. 在 Codex 的 `config.toml` 中给 Linear MCP 工具配置审批权限，让当前 Codex agent 可以按流程移动 issue 和写评论:

   ```toml
   [mcp_servers.linear.tools.save_issue]
   approval_mode = "approve"

   [mcp_servers.linear.tools.research]
   approval_mode = "approve"

   [mcp_servers.linear.tools.save_comment]
   approval_mode = "approve"

   [mcp_servers.linear.tools.prepare_attachment_upload]
   approval_mode = "approve"

   [mcp_servers.linear.tools.create_attachment_from_upload]
   approval_mode = "approve"
   ```

   服务端会默认附加 `--skip-git-repo-check`，避免目标仓库未被 Codex 标记为 trusted 时直接失败。
   阶段三如果缺少附件上传权限，会回退为只写内联结论并在评论中说明失败原因，但无法把截图等产物直接附加到 Linear。

5. 在 Linear 工作流中创建或确认这些状态名，并让 `config.local.json` 的 `statuses` 与 Linear 中的名称完全一致:

   - `Todo`: 阶段一会扫描的新需求入口。
   - `Needs Clarification`: 阶段一会复查等待用户补充的问题。
   - `Too Large`: 阶段一判定范围过大后回写到这里，等待人工审核后再转拆分。
   - `Needs Splitting`: 拆分阶段会扫描的待拆分队列入口。
   - `Blocked`: 阶段一会复查阻塞是否解除。
   - `Ready for Codex`: 阶段一判断可实现后的等待池。
   - `On Schedule`: 用户人工批准后，阶段二才会认领实现。
   - `In Progress`: 阶段二认领后的实现中状态；拆分阶段完成后父 issue 也会进入这里，但不会占用阶段二并发名额。
   - `Testing`: 阶段二完成后的 Auto Review 队列入口。
   - `Ready for Review`: 阶段三完成后等待人工验证。

   `Ready for Codex` 不会被服务自动移动到 `On Schedule`。阶段一如果判断为 `TOO LARGE`，会先把 issue 移到 `Too Large`；但不会自动继续移动到 `Needs Splitting`。从 `Too Large` 到 `Needs Splitting` 仍必须由用户在 Linear 中人工完成。

6. 在界面或 `config.local.json` 中添加项目。界面新建项目时会自动生成 `key`，用户不需要手动填写。必填字段建议按下面填写:

   - `key`: 系统生成的内部稳定标识，用于本机运行目录、处理快照和项目提示词文件名；新增项目会自动生成类似 UUID 的文件夹安全值。如果手写配置，只使用小写字母、数字和连字符。
   - `repoName`: 展示给用户和写入提示词的仓库名称。
   - `linearProjectId`: Linear 项目 UUID，只扫描这个项目下的 issue。
   - `path`: 本机仓库绝对路径，例如 `/absolute/path/to/linear-automation`。
   - `codexCwd`: `codex exec -C` 的执行目录；通常和 `path` 相同。
   - `branchOrScopePrefix`: 分支或提交 scope 前缀，例如 `main`。
   - `defaultTests`: AI Triage 没有给出测试命令时使用的默认测试，每行一条。
   - `extraRules`: 项目特定规则，只写执行约束，不要写密钥。

7. 校验配置:

   ```bash
   pnpm validate
   ```

8. 启动本地开发服务:

   ```bash
   pnpm dev:all
   ```

   前端地址: `http://127.0.0.1:8888`

   后端地址: `http://127.0.0.1:4378`

9. 首次跑通时建议按这个顺序验证:

   - 新 issue 放在 `Todo`，阶段一只分析和评论，不写代码。
   - 如果阶段一判断 `TOO LARGE`，issue 会先进入 `Too Large`；用户审核后手动把父 issue 移到 `Needs Splitting`，由拆分阶段创建子 issue 并输出覆盖清单。
   - 用户确认可实现范围后，把目标 issue 移到 `On Schedule`。
   - 阶段二只认领 `On Schedule`，先移到 `In Progress`，由当前 Codex agent 实现、测试、提交，再移到 `Testing`。
   - 阶段三只认领 `Testing`，完成 Auto Review 后按协议移动到 `Ready for Review`、`On Schedule` 或 `Blocked`。

也可以手动触发一次扫描:

```bash
pnpm once -- --stage part1
pnpm once -- --stage split
pnpm once -- --stage part2
pnpm once -- --stage part3
```

## 启动方式

完成首次配置后，本地开发模式使用:

```bash
pnpm dev:all
```

前端地址: `http://127.0.0.1:8888`

后端地址: `http://127.0.0.1:4378`

如果需要把开发服务暴露到某个明确的局域网 IP，先确认本机地址，例如 `192.168.1.23`，然后使用:

```bash
pnpm dev:lan --host 192.168.1.23
```

前端地址: `http://192.168.1.23:8888`

后端地址: `http://192.168.1.23:4378`

`dev:lan` 会让 Vite 前端服务、Vite `/api` proxy 和 Node 后端服务使用同一个具体 IP。不要使用 `0.0.0.0`；如果换成其他局域网 IP，需要停止当前服务并重新启动。

开发后端通过 Node 内置 watch 启动。运行 `pnpm dev:server` 或 `pnpm dev:all` 时，修改 `src/server` 下被后端加载的源码会自动重启后端进程，无需手动停止重启。正在执行的 Codex 会由独立 supervisor 继续运行，重启后的后端会从持久化运行记录里恢复正在执行的任务并继续提供停止按钮。

开发模式下，前端打开后会默认启动轮询。关闭轮询只会停止后续扫描，不会自动停止正在运行的 Codex 子进程；需要在项目页停止单个运行或停止当前项目。

生产模式:

```bash
pnpm build
pnpm start
```

生产模式访问 `http://127.0.0.1:4378`。

生产模式也可以指定明确的局域网 IP:

```bash
pnpm build
pnpm start:lan --host 192.168.1.23
```

生产模式局域网访问地址: `http://192.168.1.23:4378`

也可以直接覆盖后端启动参数:

```bash
pnpm start -- --host 192.168.1.23
```

命令行 `--host` 的优先级高于 `config.local.json` 里的 `host`。如果改用配置文件里的 `host`，保存后也需要重启服务才会改变实际监听地址。

生产启动 `pnpm start` 保持普通 Node 进程，不启用 watch；如果生产环境需要自动拉起或重启，应交给外部进程管理器处理。

### Docker 常驻运行

仓库提供生产镜像和 Docker Compose 配置。Compose 使用 `restart: unless-stopped`，Docker Desktop 启动后会自动恢复服务；Web 端口默认只发布到宿主机回环地址，不暴露到局域网。

1. 把 Linear API key 放进本地 env 文件（已有 `.env.local` 时无需重复创建）:

   ```bash
   cp .env.example .env.local
   # 编辑 .env.local，填写 LINEAR_API_KEY
   ```

2. 构建并后台启动:

   ```bash
   ./docker.sh up
   ```

3. 打开 `http://127.0.0.1:4378`。常用管理命令:

   ```bash
   ./docker.sh status
   ./docker.sh logs
   ./docker.sh restart
   ./docker.sh rebuild
   ./docker.sh down
   ```

容器会复用当前仓库的 `config.local.json`、`prompts/` 和 `.linear-automation/`，并挂载 `~/.codex`、`~/.gitconfig` 以及宿主机项目目录。项目目录默认使用当前用户的 `$HOME`，并以相同绝对路径挂载进容器，因此配置中的项目绝对路径不需要改写，也不会依赖某个固定用户名。可以通过 `DEVELOPER_ROOT` 将挂载范围缩小到所有项目的共同父目录；项目位于 `$HOME` 之外时也必须显式指定它。`docker.sh` 会在启动前检查该路径存在且为绝对路径。`~/.codex` 包含认证信息，只应挂载到本机可信容器，不要复制进镜像或提交到仓库。

镜像内置 Node.js、pnpm、Python、Git、ripgrep 和 Codex CLI，适合当前项目的常见检查。项目若依赖 Xcode、macOS GUI、宿主机专用命令或其他语言工具链，需要在 `Dockerfile` 中补充 Linux 工具链，或继续在宿主机直接运行服务。Codex 配置里仅适用于 macOS 的可选 MCP 服务在容器中可能不可用。

Docker 内部无法使用 Codex 的 Bubblewrap 沙箱，因此 Compose 只在容器内把四个阶段覆盖为 `danger-full-access`；宿主机 `config.local.json` 中的 sandbox 设置不会被改写。容器本身仍只挂载 Compose 中列出的目录。服务启动 Codex 时会把 `linear.apiKeyEnv` 指向的变量配置为 Linear MCP bearer token，避免依赖 macOS Keychain 中无法挂载到 Linux 的 OAuth 凭据；API key 只通过 `.env.local` / `.env` 和进程环境传递，不写入镜像或 Codex 命令行。

可选覆盖项:

```bash
# 改宿主机访问端口
WORK_AUTOMATION_PORT=14378 ./docker.sh up

# 可选：把默认的整个 $HOME 挂载缩小到所有项目的共同父目录
DEVELOPER_ROOT="$HOME/Projects" ./docker.sh up

# 项目位于 $HOME 之外时，显式指定它们的共同父目录
DEVELOPER_ROOT=/path/to/projects ./docker.sh up

# 非默认 macOS 用户 UID/GID
LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)" ./docker.sh rebuild
```

直接运行模式仍不允许 `0.0.0.0`。Compose 只在容器内部显式开启通配监听，并把宿主机发布地址限定为 `127.0.0.1`。

## 配置

在界面中配置:

- 服务 ID、监听地址、端口、轮询间隔
- Linear API 密钥环境变量名；真实密钥放在当前进程环境、`.env.local` 或 `.env` 中，不写入 `config.local.json`
- Codex 命令和默认参数
- Codex 默认只附加 `--json`；阶段一和拆分阶段默认 sandbox 为 `read-only`，阶段二默认 sandbox 为 `danger-full-access`，阶段三默认 sandbox 为 `danger-full-access`。
- Linear 工作流状态名
- 四个阶段各自的成功/失败通知开关。默认开启阶段一、阶段三的成功与失败，以及拆分阶段、阶段二的失败通知；同一策略同时控制浏览器系统通知和可选 Webhook。
- 项目、仓库路径、Codex 执行路径。Codex 执行路径默认等于仓库路径，只有需要不同工作目录时再单独修改。
- 全局和项目级阶段一 / 拆分阶段 / 阶段二 / 阶段三提示词
- 阶段三 review 产物协议、附件上传约定和基线来源约定，见 `docs/auto-review-protocol.md`

左侧侧边栏按项目展示。侧边栏底部有全局日志入口和设置入口；跳过、失败、扫描等执行事件在全局日志页查看，提示词在设置中维护。

系统通知只在页面保持开启期间检测。首次加载会把已有运行作为基线，不补发历史结果；用户取消和服务重启时恢复判定的结果也不会通知。设置页可查看或请求浏览器通知权限；点击通知会聚焦页面并打开对应运行详情。

Webhook 在服务端发送，不要求浏览器保持开启。启用后会以 GET 请求调用 URL 模板，支持 `{IssueID}`、`{IssueTitle}`、`{stage}`、`{status}`；变量值会自动进行 URL 编码。Webhook 失败会记录到全局执行日志，但不会改变原运行结果。

提示词负责指导 Codex 直接操作 Linear。默认提示词参考上级目录的 `automation-prompt` 规则并扩展到四个阶段，但当前版本不再创建子代理。

`config.local.json`、`.env.local` 和 `.env` 已加入 `.gitignore`。接口不会返回 Linear API 密钥明文。`.env.example` 是可追踪样例文件，只包含空占位。

## 命令

```bash
pnpm validate
pnpm once -- --stage part1
pnpm once -- --stage split
pnpm once -- --stage part2
pnpm once -- --stage part3
node src/server/index.mjs once --config config.local.json --stage both --issue LIV-123
node src/server/index.mjs once --config config.local.json --stage part1 --issue LIV-123 --force
```

手动指定 `--issue` 默认不会绕过状态边界：`--stage split --issue <issue>` 只有在该 issue 当前是 `Needs Splitting` 时才会启动拆分阶段；`--stage part2 --issue <issue>` 只有在该 issue 当前是 `On Schedule` 时才会启动阶段二；`--stage part3 --issue <issue>` 只有在该 issue 当前是 `Testing` 时才会启动阶段三；`--stage both --issue <issue>` 会根据当前状态自动选择阶段一、拆分阶段、阶段二或阶段三，其中 `Too Large` 仍会回到阶段一而不是直接触发拆分，不会对同一个 issue 同时启动多个阶段。

如果需要人工强制重跑：

- `--force` 会绕过“已处理快照”跳过。
- `--force` 配合 `--issue` 且显式选择 `--stage part1`、`--stage split`、`--stage part2` 或 `--stage part3` 时，会按所选阶段强制执行，不再检查当前 issue 是否仍在默认队列状态。
