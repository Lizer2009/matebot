# Matebot 部署记录

> 对应计划：[MATEBOT_PLAN.md §3 在线运行与部署](./MATEBOT_PLAN.md#3-在线运行与部署无本地电脑)  
> **最后更新**：2026-11-04

## 已选路径

| 决策 | 说明 |
| --- | --- |
| **当前采用** | **VPS / 局域网 Compose**（`infra/compose/install-images-matebot.sh` + `docker-compose.images.yml`） |
| **运行位置（今日）** | 局域网主机 `192.168.10.12`（HTTPS / 域名以该机 `.env` 为准，本文不记录真实密钥） |
| **暂缓** | **[Railway 一键模板](../infra/railway/README.md)** — 个人第二实例先走可控 VPS；待 fork 镜像与模板默认值分叉后再评估 Railway |

Railway 仍适合「零 Docker 运维」场景，见 upstream [infra/railway/README.md](../infra/railway/README.md)。Matebot **不在本阶段**维护 Railway 部署或改模板按钮。

## 容器镜像（P1-1）

CI 工作流 [`.github/workflows/publish-server-image.yml`](../.github/workflows/publish-server-image.yml) 将镜像推送到 **`ghcr.io/${{ github.repository }}/…`**。在本 fork 上即：

| 镜像 | 用途 |
| --- | --- |
| `ghcr.io/lizer2009/matebot/app` | API、worker、web、栈内 supervisor |
| `ghcr.io/lizer2009/matebot/computer` | Bot 计算机桌面 |
| `ghcr.io/lizer2009/matebot/updater` | 应用内 Compose 更新 sidecar |

常见标签：`edge`（跟踪 `main`）、`sha-<full-git-sha>`、发布 tag `v*` 对应的 semver。

### 如何触发发布

1. **推送到 `main`**：`ci.yml` 会调用 `publish-server-image`，在 GitHub runner（或配置了 `DEPOT_PROJECT_ID` 时用 Depot）构建并推送。
2. **手动**：GitHub → Actions → **publish-server-image** → **Run workflow**（`workflow_dispatch`）。
3. **发版 tag**：推送 `v*` tag 会走同一工作流并打上 semver 标签。

Pull request 只**构建校验**，不向 GHCR 推送。

镜像名由 job 内 `Resolve the image reference` 步骤生成，会先把 `github.repository` 转成小写（`${REPOSITORY,,}`）。镜像引用必须是全小写，`Lizer2009/matebot` 这种含大写的 owner 若直接拼接，每个 Build job 都会在导出阶段报 `repository name ... must be lowercase`。原生 `build` job 在 `setup-buildx` 之前会先 `Free disk space` 并 `docker image prune --all`：`app` 首次无缓存构建要把整层与 `/tmp/rootfs.tar`（供凭据扫描）同时放在根盘上，不清理会在 `write /tmp/rootfs.tar` 处 `no space left on device`。

手动重跑（fork 上没有 `DEPOT_PROJECT_ID` 时走原生 runner）：

```bash
# 1) 确认修复已在 main 上（否则 workflow_dispatch 仍会用旧版本）
git fetch origin main && git log --oneline -1 origin/main

# 2) 触发一次发布；edge 只在 github.ref 是 refs/heads/main 时打
gh workflow run publish-server-image.yml --repo Lizer2009/matebot --ref main

# 3) 跟踪结果
gh run list --repo Lizer2009/matebot --workflow publish-server-image.yml --limit 3
gh run watch --repo Lizer2009/matebot <run-id> --exit-status

# 4) 核对包已可见（公开包可匿名；私有包需先 docker login ghcr.io）
docker manifest inspect ghcr.io/lizer2009/matebot/app:edge | head -20
```

### 一次性：fork 上的 GHCR / Actions 权限

若推送失败且日志出现 package 权限或 `denied`：

1. **Settings → Actions → General → Workflow permissions**：选 **Read and write permissions**，并允许 workflow 写入 packages（或保持默认「Read repository contents + packages: write」由 job 声明）。
2. **Settings → Actions → General**：确认 **Allow GitHub Actions to create and approve pull requests** 按需即可；发布镜像不需要 PAT，job 使用 `GITHUB_TOKEN` 登录 `ghcr.io`。
3. **私有包拉取**：在 VPS 上对私有 GHCR 包执行 `docker login ghcr.io`（Classic PAT 或 fine-grained token，scope 含 `read:packages`）。公开包可匿名 pull。
4. 首次推送后，在 **Packages** 里可将包可见性设为 private/public；Compose 默认引用本仓库命名空间下的包。

仍可通过 `.env` 覆盖任意镜像，例如 `RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app` 继续用上游镜像。

### 环境模板默认值

- 上游默认：[`infra/compose/.env.images.example`](../infra/compose/.env.images.example) → `ghcr.io/elie222/rakazo/…`
- Matebot 默认：[`infra/compose/.env.images.matebot.example`](../infra/compose/.env.images.matebot.example) → `ghcr.io/lizer2009/matebot/…`

## VPS / Compose 要点（P1-2）

1. 推荐使用 fork 安装入口（下载基址与 env 模板均指向本仓库）；仍可用 upstream GHCR 镜像时在 `.env` 覆盖 `RAKAZO_IMAGE`。
2. 公网或 LAN 访问：配置 `BETTER_AUTH_URL`、`WEB_ORIGIN`、`API_URL`、`RAKAZO_HOST`（生产见 [self-host-production.md](./self-host-production.md)）。
3. **模型**：实例已接 OpenAI 兼容端点（示例：`https://api.deepseek.com/v1`，模型 `deepseek-chat`）；密钥仅存在于服务器 `.env`，勿提交仓库。
4. **Bot 计算机**：有 Docker socket 时可用 `SANDBOX_PROVIDER=docker`；纯 PaaS 或无 socket 时改用 `e2b`、`boat` 等（[self-host-sandbox-providers.md](./self-host-sandbox-providers.md)）。

### 首次 / 升级（操作员）

```bash
mkdir -p matebot && cd matebot
curl -fsSLO https://raw.githubusercontent.com/Lizer2009/matebot/main/infra/compose/install-images-matebot.sh
bash install-images-matebot.sh --prepare-only
# 编辑 .env（见下方清单）
bash install-images-matebot.sh
```

等价手动设置：

```bash
export RAKAZO_DOWNLOAD_BASE=https://raw.githubusercontent.com/Lizer2009/matebot/main/infra/compose
export RAKAZO_ENV_IMAGES_EXAMPLE=.env.images.matebot.example
bash install-images.sh --prepare-only
```

上游官方安装命令仍使用 [`install-images.sh`](../infra/compose/install-images.sh) 与 `elie222/rakazo` raw URL，便于与 upstream 合并。

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

P1-1 / P1-2 验收勾选见 [MATEBOT_PLAN.md §6](./MATEBOT_PLAN.md#6-优先级-backlog接下来-12-轮编码)。
