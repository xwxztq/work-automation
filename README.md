# Linear Codex 自动执行

本地服务，用于在每台服务器上执行 Linear 到 Codex 的两阶段流程。

## 功能

- 读取当前机器配置的 Linear 项目。
- 阶段一处理 `Todo / Needs Clarification / Blocked`。
- 阶段二只处理 `On Schedule`。
- 使用 `codex exec --json -C <project.codexCwd> -` 启动 Codex。
- 运行日志写入 `.linear-automation/runs`。
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
- 项目、仓库路径、Codex 执行路径
- 全局和项目级阶段一 / 阶段二提示词

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
