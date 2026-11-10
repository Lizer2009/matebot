# Matebot 部署记录

> 对应计划：[MATEBOT_PLAN.md §3 在线运行与部署](./MATEBOT_PLAN.md#3-在线运行与部署无本地电脑)  
> **最后更新**：2026-11-05

## 已选路径

| 决策 | 说明 |
| --- | --- |
| **当前采用** | **VPS / 局域网 Compose**（`infra/compose/install-images-matebot.sh` + `docker-compose.images.yml`） |
| **运行位置（今日）** | 局域网主机 `192.168.10.5`（HTTPS / 域名以该机 `.env` 为准，本文不记录真实密钥） |
| **暂缓** | **[Railway 一键模板](../infra/railway/README.md)** — 个人第二实例先走可控 VPS；待 fork 镜像与模板默认值分叉后再评估 Railway |

Railway 仍适合「零 Docker 运维」场景，见 upstream [infra/railway/README.md](../infra/railway/README.md)。Matebot **不在本阶段**维护 Railway 部署或改模板按钮。

### 2026-11-05 主机迁移（`.12` → `.5`）

原 `192.168.10.12` 上的 Matebot 已整体迁移到 `192.168.10.5`：数据库与 appdata 从旧机恢复，容器、卷与镜像在旧机清理，旧机安装目录只留 `MIGRATED_TO_05.txt` 标记。**后续部署与验收目标改为 `192.168.10.5`**，不要再用 `.12` 验证。

- Web：`http://192.168.10.5:5173`
- 镜像不变：`ghcr.io/lizer2009/matebot/{app,computer}:edge`
- 服务器 `.env` 沿用迁移前的内容（含 `CLOUD_AGENT_*`、MCP 私有端点允许列表、模型私有 host、`PRODUCT_DISPLAY_NAME=Matebot`），密钥仍只存在于该机 `.env`。
- 迁移期间曾为让自助问答与 `/` 技能选择器立即显示 Matebot 而在运行层做过临时改动；这些改动只存在于该机，重启或换镜像即丢失。以本仓库（`PRODUCT_DISPLAY_NAME` + 内建技能）构建的 `edge` 镜像才是它们的正式来源，重新拉取镜像并重启后不再需要手工补丁。


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

仍可通过 `.env` 覆盖任意镜像，例如 `MATEBOT_IMAGE=ghcr.io/lizer2009/matebot/app` 继续用上游镜像。

### 环境模板默认值

- 上游默认：[`infra/compose/.env.images.example`](../infra/compose/.env.images.example) → `ghcr.io/lizer2009/matebot/…`
- Matebot 默认：[`infra/compose/.env.images.matebot.example`](../infra/compose/.env.images.matebot.example) → `ghcr.io/lizer2009/matebot/…`

## VPS / Compose 要点（P1-2）

1. 推荐使用 fork 安装入口（下载基址与 env 模板均指向本仓库）；仍可用 upstream GHCR 镜像时在 `.env` 覆盖 `MATEBOT_IMAGE`。
2. 公网或 LAN 访问：配置 `BETTER_AUTH_URL`、`WEB_ORIGIN`、`API_URL`、`MATEBOT_HOST`（生产见 [self-host-production.md](./self-host-production.md)）。
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
export MATEBOT_DOWNLOAD_BASE=https://raw.githubusercontent.com/Lizer2009/matebot/main/infra/compose
export MATEBOT_ENV_IMAGES_EXAMPLE=.env.images.matebot.example
bash install-images.sh --prepare-only
```

上游官方安装命令仍使用 [`install-images.sh`](../infra/compose/install-images.sh) 与其 raw URL。

## Secrets 与配置清单（占位符）

部署前在 **服务器 `.env`** 中准备（名称与 upstream 一致；值为占位符，勿写入 git）：

| 变量 | 用途 |
| --- | --- |
| `ENCRYPTION_KEY` | 应用级加密（至少 32 字符） |
| `BETTER_AUTH_SECRET` | 会话 / Cookie 签名 |
| `BETTER_AUTH_URL` | 浏览器可见的认证 origin（HTTPS 生产 URL） |
| `WEB_ORIGIN` / `API_URL` / `MATEBOT_HOST` | 与公网 URL 一致 |
| `POSTGRES_PASSWORD` / `POSTGRES_APP_PASSWORD` | 数据库（与 upstream 实例 **独立**） |
| `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` 或 BYOK | 默认模型；OpenAI 兼容 `baseUrl` + API key |
| `SANDBOX_PROVIDER` | 计算机后端（`docker` / `e2b` / `boat` / `none` 等） |
| `SANDBOX_SUPERVISOR_TOKEN` | Compose 栈要求（即使 `none` 也需设置） |
| 远程沙箱密钥 | 按 provider：`E2B_*`、`BOAT_*`、`DAYTONA_*` 等 |
| `CLOUD_AGENT_PROVIDER` | 产品内 Cursor 工具：`emulator`（无网络）或 `cursor`（生产） |
| `CLOUD_AGENT_SPACE_ID` | Cursor Space（与 upstream 实例 **分开**） |
| `CURSOR_API_KEY` | 仅服务器 env；启用 `cursor` 时必填 |
| `CLOUD_AGENT_MODEL` | 可选。Cursor 云端 Agent 的模型 id（如 `deepseek-v41-flash-1017`）；不设则保持提供方默认 |
| `MCP_ALLOW_PRIVATE_ENDPOINT` | 允许 MCP 连接内网地址（仅在你信任该网络时设为 `true`） |
| `MATEBOT_OPENAI_COMPAT_PRIVATE_HOSTS` | 以逗号分隔的私有/自定义模型 host 允许列表（如 `api.deepseek.com`） |

`PRODUCT_DISPLAY_NAME` 不是环境变量：它是 `packages/core/src/product-brand.ts` 里的构建期常量，所以改品牌要改代码并重新出镜像，而不是改 `.env`。

### 营销站与下载（`apps/www`）

营销站与产品是**两个独立域名**：营销站 `test.matebot.dev`，应用（登录/注册）`app.test.matebot.dev`。营销站构建期读取两个环境变量，改域名不需要改代码：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `MATEBOT_MARKETING_URL` | `https://test.matebot.dev` | canonical、hreflang、sitemap、结构化数据、站内绝对链接；产品帮助技能生成文档链接时也读它 (`packages/core/src/document-origin.ts`) |
| `MATEBOT_APP_URL` | `https://app.test.matebot.dev` | 所有「开始使用 / 在浏览器里打开 / 登录」链接、插件 API 与集成认领地址 |

两者都接受 absolute origin（含协议与端口）；无效值会回退到默认值。迁移到主域 `matebot.dev` 时，把这两个变量改成 `https://matebot.dev` 与 `https://app.matebot.dev` 后重新构建即可；Cloudflare Tunnel、`BETTER_AUTH_URL`、`WEB_ORIGIN`、`API_URL`、`MATEBOT_HOST` 需在同一次切换中一并更新。

Windows 安装包下载由 `/api/download?platform=windows` 解析，顺序是：

1. 最新 GitHub Release 里名为 `*.exe` 的资产（`Matebot-Setup-<version>.exe`）；
2. 若都没有，读 `MATEBOT_WINDOWS_INSTALLER`：可以是站内路径（如 `/downloads/Matebot-Setup-0.6.0.exe`）或 `https://` 绝对地址；
3. 仍未配置则跳到 Releases 页面，而不是给出死链。

因此上线前需要**二选一**：

- **推荐**：用 `release-desktop` 走一次带签名的正式发布（`v*` tag），资产上传后站点自动指向它；
- 或把 `desktop-windows-installer` 工作流产出的 artifact 解压，把 `Matebot-Setup-0.6.0.exe` 放到营销站的 `apps/www/public/downloads/`，并在营销站环境里设 `MATEBOT_WINDOWS_INSTALLER=/downloads/Matebot-Setup-0.6.0.exe`。

二进制不进 git：`apps/www/public/downloads/` 由运维在部署机上放置，路径必须与 `MATEBOT_WINDOWS_INSTALLER` 一致。

Android APK 由 `/api/download?platform=android` 解析，读的是滚动 Release **`android` 标签**（不是 `releases/latest`，那个标签属于桌面更新器），资产名固定为 `matebot.apk`。首次 APK 由 `release-android-apk` 工作流发布：

```sh
gh workflow run release-android-apk.yml --repo Lizer2009/matebot --ref main
```

在该资产出现之前，首页的 Android 按钮与下载页仍会展示，但 `/api/download?platform=android` 会跳到 Releases 页面，而不是死链。因此**顺序是：先发 APK，再发营销站**，或者接受首屏 Android 按钮短暂跳到 Releases。首页与下载页在构建期不探测该 Release，站点无需为了 APK 上线重新构建。

### 环境变量命名

所有身份统一使用 Matebot 命名，不再保留旧名的兼容分支或别名：

| 身份 | 当前值 |
| --- | --- |
| 环境变量前缀 | `MATEBOT_*`（`MATEBOT_HOST`、`MATEBOT_IMAGE`、`MATEBOT_DOCKER_BINARY`、`MATEBOT_PASSKEY_RP_ID` 等） |
| Postgres 角色 / 库 | 迁移角色 `matebot`、应用角色 `matebot_app`、库名 `matebot` |
| Compose 项目名 | `matebot`（镜像栈）、`matebot-prod`（生产栈） |
| 卷名 | `pgdata`、`appdata`、`webassets` |
| 镜像 | `ghcr.io/lizer2009/matebot/{app,computer,updater}` |
| 移动端 | URL scheme `matebot://`、bundle id `com.matebot.app` |
| 桌面 | `productName` / `appId`、安装包与可执行文件名、AppData 目录名 |

**已有部署升级**：旧名下的 `.env`、数据库角色、Compose 卷不会自动改名，升级前需要一次性迁移：变量名批量替换、`ALTER ROLE`/`ALTER DATABASE` 改名、卷改名或保持卷名只换配置。完整步骤与验收项见 [Matebot identity migration](./matebot-identity-migration.md)。未执行迁移的部署会读不到原有密钥或连不上原数据库。

**桌面配置目录**：桌面应用直接使用 Electron 按 `productName` 推导的目录（Windows 为 `%APPDATA%\Matebot`，macOS 为 `~/Library/Application Support/Matebot`），不再查找任何旧产品名下的目录。按迁移指南重装时，旧目录由操作者自行保留或删除；应用不会读取它。

**OpenRouter 归因**：`HTTP-Referer` 取部署自身的 origin（`MATEBOT_MARKETING_URL`），不再指向任何外部站点。

**桌面配置目录迁移**：旧构建把配置写在以显示名命名的目录（Windows 为 `%APPDATA%\Matebot`，macOS 为 `~/Library/Application Support/Matebot`）。新构建启动时若新目录不存在而旧目录存在，会整体迁移过去（同盘为 rename，跨盘为复制后删除）。若两个目录都存在，则以新目录为准，旧目录保留不动。

**仍需人工确认**：Passkey 的 RP ID 默认值随部署域名变为 `test.matebot.dev`；已在旧域名注册的 passkey 在桌面应用中不再可用，需要重新注册。服务器侧 `MATEBOT_PASSKEY_RP_ID` 与 `WEB_ORIGIN` 需与前端域名一致。

Cursor 集成说明：[self-host-integrations.md](./self-host-integrations.md#enable-cursor)。本 fork 的 Cloud Agent **改代码**流程见 [MATEBOT_CURSOR.md](./MATEBOT_CURSOR.md)（与服务器上 `CLOUD_AGENT_*` 互补）。

## 与 upstream 的关系（Git）

本仓库自 0.6.0 起为独立开发基线，不再合并上游分支。上游代码只作为 Apache-2.0 的来历与署名保留在 `LICENSE` 与 README 中，日常开发与发布都在本仓库内完成。

### 历史同步点（仅作来历参考）

| Ref | SHA | 说明 |
| --- | --- | --- |
| `origin/main`（Lizer2009/matebot） | `b722f80f2e51181056c539396293b6051898abad` | fork 默认分支 |
| 分叉时点的上游 `main` | `d97c5fd70d90ef37ef86758d20b67d3077f9f5b2` | fork 的代码起点 |

## Fork CI 说明

本仓库的 `ci.yml` / `playwright.yml` 统一在 `ubuntu-latest` 上运行。上游组织使用的 `incredibuild-ubuntu-latest` 标签在本仓库不存在；若把 `runs-on` 指向该标签，run 会创建成功但永远没有 runner 被分配（0 jobs，pending），必需检查因此不会产生结果。

- **Vercel**：fork PR 上若出现「Authorization required to deploy」，为预期行为，可忽略（非 merge 阻塞项，除非 fork 单独配置了 Vercel 必需检查）。
- **生产 deploy / Tailscale / Expo OTA**：仅 upstream `main` push 且配置了 secrets 时运行；fork 不依赖这些 job。

## 相关文档

- [MATEBOT_PLAN.md](./MATEBOT_PLAN.md) — 总计划与 backlog  
- [MATEBOT_CURSOR.md](./MATEBOT_CURSOR.md) — Cursor Cloud Agent 改本仓库  
- [self-host.md](./self-host.md) — 自托管总览  

P1-1 / P1-2 验收勾选见 [MATEBOT_PLAN.md §6](./MATEBOT_PLAN.md#6-优先级-backlog接下来-12-轮编码)。
