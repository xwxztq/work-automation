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

## 配置

在界面中配置:

- 服务 ID、监听地址、端口、轮询间隔
- Linear API 密钥环境变量名
- Codex 命令和默认参数
- Linear 工作流状态名
- 项目、仓库路径、Codex 执行路径。Codex 执行路径默认等于仓库路径，只有需要不同工作目录时再单独修改。
- 全局和项目级阶段一 / 阶段二提示词

左侧侧边栏按项目展示。设置入口在侧边栏底部，提示词也在设置中维护。

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
