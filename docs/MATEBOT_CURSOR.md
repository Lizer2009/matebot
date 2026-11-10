# Matebot × Cursor Cloud Agent

在 **不依赖本地桌面** 的前提下，用 [Cursor Cloud Agent](https://cursor.com/docs/cloud-agent) 改 [Lizer2009/matebot](https://github.com/Lizer2009/matebot) 并开 PR。

## 仓库环境

根目录 [`.cursor/environment.json`](../.cursor/environment.json) 声明 Cloud Agent 构建步骤：

- **`install`**：`pnpm install --frozen-lockfile`，然后 `pnpm db:generate`（与 CI 相同占位 `DATABASE_URL`）。
- **无默认 `start`**：全栈 `pnpm dev` 需 Postgres、Docker 计算机等，一般在 Agent 会话里按需用 tmux 启动，而非每次 boot 自动拉起。

Monorepo 使用 **pnpm 9**、**Node 22+**（见根 [package.json](../package.json)）。包名仍为 `@matebot/*`。

## 推荐工作流

1. 在 Cursor 中对 **matebot** 仓库启动 Cloud Agent（或从 Issue/PR 继续）。
2. Agent 基于 environment build 检出你的分支；若依赖相对 `main` 有变，在会话内再跑 `pnpm install --frozen-lockfile`。
3. **验证**（与 CI 对齐，按改动范围选子集）：
   - 全库或受影响包：`pnpm check`（Turbo typecheck）
   - 单元测试：`pnpm test`（vitest；CI 三分片，本地可全跑）
   - 仅文档 / `.cursor` 配置：PR 上可能跳过 typecheck/unit（见 `.github/scripts/changed-areas.sh`）
   - 集成：`pnpm test:integration` — 需要 Docker（Testcontainers Postgres）
   - **不要**在 Cloud Agent 上常规跑 Electron E2E（会抢焦点；见 [AGENTS.md](../AGENTS.md)）
4. 提交到 `cursor/<topic>-f26c` 分支，`git push -u origin …`，开 PR 指向 `main`。
5. 等 fork CI **Checks** 变绿；Vercel 授权失败 on fork 可忽略（见 [MATEBOT_DEPLOY.md](./MATEBOT_DEPLOY.md#fork-ci-说明)）。

## 与已部署 Matebot 的关系

| 能力 | Cloud Agent 改代码 | 已部署实例（VPS） |
| --- | --- | --- |
| 编辑 TS、文档、开 PR | ✅ | — |
| 跑单元测试 / typecheck | ✅ | — |
| 手测 UI / Bot 对话 | ⚠️ 需自启 dev 栈 | ✅ 用 LAN/HTTPS URL |
| Bot 内 `cloud_agent_launch` | — | 在服务器 `.env` 配 `CLOUD_AGENT_*`（见 [self-host-integrations.md](./self-host-integrations.md)） |

在线实例部署见 [MATEBOT_DEPLOY.md](./MATEBOT_DEPLOY.md)。产品路线图见 [MATEBOT_PLAN.md](./MATEBOT_PLAN.md)。

## 本地等价命令（参考）

```bash
pnpm install --frozen-lockfile
DATABASE_URL=postgres://matebot:matebot@127.0.0.1:5433/matebot pnpm db:generate
pnpm lint
pnpm check
pnpm test
```

全栈开发：`pnpm dev`（需 Postgres、可选 Docker computer）。详见 [docs/self-host.md](./self-host.md)。
