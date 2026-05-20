<p align="center">
  <img src="public/WA-logo.png" alt="WorkAutomation logo" width="96" />
</p>

# Linear Codex 自动执行

本地服务，用于在每台服务器上执行 Linear 到 Codex 的两阶段流程。

## 功能

- 读取当前机器配置的 Linear 项目。
- 阶段一检测 `Todo / Needs Clarification / Blocked` 并启动 Codex 做分析。
- 阶段二检测 `On Schedule` 并启动 Codex 做实现。
- 服务端只负责扫描队列、启动 Codex、记录日志和停止子进程；Linear 评论和状态移动由 Codex agent 直接完成。
- 多个项目并行执行，同一项目内按 issue 串行执行。
- 使用 `codex exec --json -C <project.codexCwd> -` 启动 Codex。
- 支持停止单个运行或当前项目的运行。
- 单次运行日志写入 `.linear-automation/runs`，全局执行日志写入 `.linear-automation/events.jsonl`。
- 已处理 issue 的快照 MD5 写入 `.linear-automation/processed-issues.json`。自动扫描时，如果当前 Linear issue 自上次处理后没有变化，会跳过，避免 Blocked 等状态被重复评论；手动指定 issue 执行不受这个跳过规则影响。
- 不自动移动 issue 到 `Done`。

## 启动

```bash
pnpm install
cp config.example.json config.local.json
export LINEAR_API_KEY='你的 Linear API key'
pnpm dev:all
```

前端地址: `http://127.0.0.1:8888`

后端地址: `http://127.0.0.1:4378`

开发模式下，前端打开后会默认启动轮询。关闭轮询只会停止后续扫描，不会自动停止正在运行的 Codex 子进程；需要在项目页停止单个运行或停止当前项目。

生产模式:

```bash
pnpm build
export LINEAR_API_KEY='你的 Linear API key'
pnpm start
```

生产模式访问 `http://127.0.0.1:4378`。

## 新用户配置步骤

1. 复制本地配置文件:

   ```bash
   cp config.example.json config.local.json
   ```

2. 只在当前 shell 或进程环境中设置 Linear API key，不要写入 `config.local.json`:

   ```bash
   export LINEAR_API_KEY='你的 Linear API key'
   ```

   如果改用其他环境变量名，需要同步修改 `linear.apiKeyEnv`，并确保启动服务的进程能读取到这个变量。

3. 在 Linear 工作流中创建或确认这些状态名，并让 `config.local.json` 的 `statuses` 与 Linear 中的名称完全一致:

   - `Todo`: 阶段一会扫描的新需求入口。
   - `Needs Clarification`: 阶段一会复查等待用户补充的问题。
   - `Blocked`: 阶段一会复查阻塞是否解除。
   - `Ready for Codex`: 阶段一判断可实现后的等待池。
   - `On Schedule`: 用户人工批准后，阶段二才会认领实现。
   - `In Progress`: 当前 Codex agent 已认领并正在实现。
   - `Testing`: Codex 完成 scoped commit 后等待人工验证。

   `Ready for Codex` 不会被服务自动移动到 `On Schedule`。这个转换必须由用户在 Linear 中人工完成。

4. 在界面或 `config.local.json` 中添加项目。必填字段建议按下面填写:

   - `key`: 本机配置内使用的稳定项目标识，例如 `work-automation`。
   - `repoName`: 展示给用户和写入提示词的仓库名称。
   - `linearProjectId`: Linear 项目 UUID，只扫描这个项目下的 issue。
   - `path`: 本机仓库绝对路径，例如 `/Users/san/Projects/Infra/linear/linear-automation`。
   - `codexCwd`: `codex exec -C` 的执行目录；通常和 `path` 相同。
   - `branchOrScopePrefix`: 分支或提交 scope 前缀，例如 `main`。
   - `defaultTests`: AI Triage 没有给出测试命令时使用的默认测试，每行一条。
   - `extraRules`: 项目特定规则，只写执行约束，不要写密钥。

5. 校验配置并启动:

   ```bash
   pnpm validate
   pnpm dev:all
   ```

   也可以手动触发一次扫描:

   ```bash
   pnpm once -- --stage part1
   pnpm once -- --stage part2
   ```

6. 首次跑通时建议按这个顺序验证:

   - 新 issue 放在 `Todo`，阶段一只分析和评论，不写代码。
   - 用户确认范围后，把 issue 移到 `On Schedule`。
   - 阶段二只认领 `On Schedule`，先移到 `In Progress`，由当前 Codex agent 实现、测试、提交，再移到 `Testing`。

## 配置

在界面中配置:

- 服务 ID、监听地址、端口、轮询间隔
- Linear API 密钥环境变量名
- Codex 命令和默认参数
- Linear 工作流状态名
- 项目、仓库路径、Codex 执行路径。Codex 执行路径默认等于仓库路径，只有需要不同工作目录时再单独修改。
- 全局和项目级阶段一 / 阶段二提示词

左侧侧边栏按项目展示。侧边栏底部有全局日志入口和设置入口；跳过、失败、扫描等执行事件在全局日志页查看，提示词在设置中维护。

提示词负责指导 Codex 直接操作 Linear。默认提示词参考上级目录的 `automation-prompt` 两阶段规则，但当前版本不再创建子代理。

`config.local.json` 已加入 `.gitignore`。接口不会返回 Linear API 密钥明文。

## 命令

```bash
pnpm validate
pnpm once -- --stage part1
pnpm once -- --stage part2
node src/server/index.mjs once --config config.local.json --stage both --issue LIV-123
```

## shadcn

前端基础组件来自 `src/components/ui` 下的 shadcn/ui 组件。业务页面只组合这些组件。
