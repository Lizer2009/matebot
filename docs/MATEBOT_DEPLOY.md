# Matebot 部署记录

> 对应计划：[MATEBOT_PLAN.md §3 在线运行与部署](./MATEBOT_PLAN.md#3-在线运行与部署无本地电脑)  
> **最后更新**：2026-11-04

## 已选路径

| 决策 | 说明 |
| --- | --- |
| **当前采用** | **VPS / 局域网 Compose**（`infra/compose/install-images.sh` + `docker-compose.images.yml`） |
| **运行位置（今日）** | 局域网主机 `192.168.10.12`（HTTPS / 域名以该机 `.env` 为准，本文不记录真实密钥） |
| **暂缓** | **[Railway 一键模板](../infra/railway/README.md)** — 个人第二实例先走可控 VPS；待 fork 镜像与模板默认值分叉后再评估 Railway |

Railway 仍适合「零 Docker 运维」场景，见 upstream [infra/railway/README.md](../infra/railway/README.md)。Matebot **不在本阶段**维护 Railway 部署或改模板按钮。

## VPS / Compose 要点

1. 在部署目录使用 upstream 或 fork 的 compose 文件；当前实例通过 **install-images** 流程拉取 **upstream GHCR** 镜像（`ghcr.io/elie222/rakazo/*`），与 [MATEBOT_PLAN §3.4](./MATEBOT_PLAN.md#34-fork-镜像与安装脚本中期必做) 中期目标（fork GHCR）无关，可继续运行。
2. 公网或 LAN 访问：配置 `BETTER_AUTH_URL`、`WEB_ORIGIN`、`API_URL`、`RAKAZO_HOST`（生产见 [self-host-production.md](./self-host-production.md)）。
3. **模型**：实例已接 OpenAI 兼容端点（示例：`https://api.deepseek.com/v1`，模型 `deepseek-chat`）；密钥仅存在于服务器 `.env`，勿提交仓库。
4. **Bot 计算机**：有 Docker socket 时可用 `SANDBOX_PROVIDER=docker`；纯 PaaS 或无 socket 时改用 `e2b`、`boat` 等（[self-host-sandbox-providers.md](./self-host-sandbox-providers.md)）。

### 首次 / 升级（操作员）

```bash
mkdir -p matebot && cd matebot
curl -fsSLO https://raw.githubusercontent.com/Lizer2009/matebot/main/infra/compose/install-images.sh
# 或仍用 upstream raw URL，直到 fork 专用 install 脚本落地（P1-2）
bash install-images.sh --prepare-only
# 编辑 .env（见下方清单）
bash install-images.sh
```

模板文件：[infra/compose/.env.images.example](../infra/compose/.env.images.example)。

## Secrets 与配置清单（占位符）

部署前在 **服务器 `.env`** 中准备（名称与 upstream 一致；值为占位符，勿写入 git）：

| 变量 | 用途 |
| --- | --- |
| `ENCRYPTION_KEY` | 应用级加密（至少 32 字符） |
| `BETTER_AUTH_SECRET` | 会话 / Cookie 签名 |
| `BETTER_AUTH_URL` | 浏览器可见的认证 origin（HTTPS 生产 URL） |
| `WEB_ORIGIN` / `API_URL` / `RAKAZO_HOST` | 与公网 URL 一致 |
| `POSTGRES_PASSWORD` / `POSTGRES_APP_PASSWORD` | 数据库（与 upstream 实例 **独立**） |
| `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` 或 BYOK | 默认模型；OpenAI 兼容 `baseUrl` + API key |
| `SANDBOX_PROVIDER` | 计算机后端（`docker` / `e2b` / `boat` / `none` 等） |
| `SANDBOX_SUPERVISOR_TOKEN` | Compose 栈要求（即使 `none` 也需设置） |
| 远程沙箱密钥 | 按 provider：`E2B_*`、`BOAT_*`、`DAYTONA_*` 等 |
| `CLOUD_AGENT_PROVIDER` | 产品内 Cursor 工具：`emulator`（无网络）或 `cursor`（生产） |
| `CLOUD_AGENT_SPACE_ID` | Cursor Space（与 upstream 实例 **分开**） |
| `CURSOR_API_KEY` | 仅服务器 env；启用 `cursor` 时必填 |

Cursor 集成说明：[self-host-integrations.md](./self-host-integrations.md#enable-cursor)。本 fork 的 Cloud Agent **改代码**流程见 [MATEBOT_CURSOR.md](./MATEBOT_CURSOR.md)（与服务器上 `CLOUD_AGENT_*` 互补）。

## 与 upstream 同步（Git）

Matebot 定期合并 [elie222/rakazo](https://github.com/elie222/rakazo) 的 `main`：

```bash
git remote add upstream https://github.com/elie222/rakazo.git   # 仅首次
git fetch upstream
git checkout main
git merge upstream/main   # 或 rebase，按团队习惯
git push origin main
```

### 跟踪 commit（2026-11-04 自本仓库观测）

| Ref | SHA | 说明 |
| --- | --- | --- |
| `origin/main`（Lizer2009/matebot） | `b722f80f2e51181056c539396293b6051898abad` | fork 默认分支 |
| `upstream/main`（elie222/rakazo） | `d97c5fd70d90ef37ef86758d20b67d3077f9f5b2` | `git fetch https://github.com/elie222/rakazo.git main` |

合并前请重新 `git fetch upstream` 并更新上表。冲突热点见 [MATEBOT_PLAN §4.2](./MATEBOT_PLAN.md#42-推荐-git-工作流)。

## Fork CI 说明

GitHub Actions 在 **elie222/rakazo** 上使用组织 Incredibuild runner（`incredibuild-ubuntu-latest`）。**Lizer2009/matebot** 无该标签时，`ci.yml` / `playwright.yml` 回退到 `ubuntu-latest`，必需检查（Lint and typecheck、Unit tests、Checks 等）应能在 fork PR 上完成。

- **Vercel**：fork PR 上若出现「Authorization required to deploy」，为预期行为，可忽略（非 merge 阻塞项，除非 fork 单独配置了 Vercel 必需检查）。
- **生产 deploy / Tailscale / Expo OTA**：仅 upstream `main` push 且配置了 secrets 时运行；fork 不依赖这些 job。

## 相关文档

- [MATEBOT_PLAN.md](./MATEBOT_PLAN.md) — 总计划与 backlog  
- [MATEBOT_CURSOR.md](./MATEBOT_CURSOR.md) — Cursor Cloud Agent 改本仓库  
- [self-host.md](./self-host.md) — 自托管总览  
