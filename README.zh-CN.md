# Matebot

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

**Matebot** 是一个由你自己掌控的自托管 AI 队友：持久运行的机器人可以使用真实的电脑、按计划执行任务，并在网页、桌面和手机客户端之间保留记忆与历史。它运行在你自己的服务器上，使用你自己的模型凭据，也不需要本地桌面环境。

本仓库是 **[Rakazo](https://github.com/elie222/rakazo)** 的分叉，Matebot 构建在它的 Apache-2.0 代码之上。Matebot 保留该许可证、其声明，以及清晰的上游署名；差异在于产品名称、打包方式和本 fork 运行的部署。

| | |
| --- | --- |
| **当前部署** | https://test.matebot.dev |
| **分叉计划与进度** | [docs/MATEBOT_PLAN.md](./docs/MATEBOT_PLAN.md) |
| **部署记录** | [docs/MATEBOT_DEPLOY.md](./docs/MATEBOT_DEPLOY.md) |
| **Cursor Cloud Agent** | [docs/MATEBOT_CURSOR.md](./docs/MATEBOT_CURSOR.md) |
| **品牌资源** | [docs/MATEBOT_BRAND.md](./docs/MATEBOT_BRAND.md) |
| **Windows 安装包** | [docs/desktop-release.md](./docs/desktop-release.md) |

本文是 [英文 README](./README.md) 的简体中文译文，链接指向的其他文档目前仍为英文。

## 功能

- 持久运行的机器人，各自拥有会话、记忆、例程和历史
- 语音模式：朗读回复、听写、呼叫机器人。可接入自己的 ElevenLabs、OpenAI、Cartesia 或 Fish Audio 密钥，也可使用 Mac 服务器上已安装的声音
- 共享团队计算机与相互隔离的私有计算机
- 浏览器、终端、文件与图形桌面操作能力
- 机器人可以委派给同侪机器人或短时子代理
- 通过 Pi 接入你自己的模型凭据
- 通过 Composio 或 Pipedream Connect 接入应用，也可自行安装 Treg、远程 MCP 与 OpenAPI 工具源
- 支持 Docker、E2B、Daytona、CreateOS、Boat 以及受信任的本地计算机

## 快速开始（使用已发布镜像）

需要 Docker Engine、Compose 插件、curl 与 OpenSSL，无需克隆仓库或安装 Node。

```bash
mkdir -p matebot && cd matebot &&
curl -fsSLO https://raw.githubusercontent.com/Lizer2009/matebot/main/infra/compose/install-images-matebot.sh &&
bash install-images-matebot.sh
```

安装脚本会下载 Compose 文件、生成带随机密钥的 `.env` 并启动 Matebot。重复执行时会保留已有的 `.env`。

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，创建账号并连接模型。本地 Docker 计算机默认开启；可选远程提供方为 `e2b`、`novita`、`daytona`、`createos`、`boat`、`boxd` 或 `railway`，需配置对应的 API 密钥。

镜像来自本 fork 的仓库 `ghcr.io/lizer2009/matebot/{app,computer,updater}`：main 构建使用 `edge` 标签，每次提交另有 `sha-<commit>`。详见[自托管指南](./docs/self-host.md#published-images-no-checkout)。

上游安装脚本 `install-images.sh` 仍然可用，但它拉取上游镜像；只有在你确实想运行上游构建时才使用它。

在受限网络中，可覆盖安装脚本下载基址（`RAKAZO_DOWNLOAD_BASE`）、跳过已存在的 Compose 文件（`--local` / `RAKAZO_DOWNLOAD_SKIP_EXISTING`），或镜像引导脚本 URL，见[受限网络 / 镜像下载](./docs/self-host.md#restricted-networks--mirror-downloads)。

如需代理辅助安装，请使用 [SETUP_PROMPT.md](./SETUP_PROMPT.md)。

## 在服务器上运行

后端运行在服务器上时，机器人会持续在线。在 VPS 上使用同一个安装脚本，然后通过桌面应用、手机应用或浏览器连接。

```bash
bash install-images-matebot.sh --prepare-only
# 编辑 .env：SANDBOX_PROVIDER=boat（或 e2b / daytona / createos）及其 API 密钥，RAKAZO_HOST=your.domain
bash install-images-matebot.sh
```

在 5173 端口前配置 HTTPS；[docs/self-host-production.md](./docs/self-host-production.md#public-single-vm-deployment) 介绍了 Caddy 配置与主机加固。在桌面应用中选择 **Existing instance** 并填入 `https://` 地址。

## 本地开发（源码检出）

需要 Node.js 22.x 中 22.22.2 或更高版本、Node.js 24.x，或 Node.js 26+；pnpm 9；以及 Docker。不支持 Node.js 23.x 与 25.x。

```bash
git clone https://github.com/Lizer2009/matebot.git
cd matebot
cp .env.example .env
```

用 `openssl rand -hex 16` 生成两个值，分别填入 `POSTGRES_PASSWORD` 与 `POSTGRES_APP_PASSWORD`，再写入 `DATABASE_MIGRATION_URL` 与 `DATABASE_URL`。应用使用自己的 `rakazo_app` 登录，行级安全策略作用于该角色；迁移以所有者身份执行（见[数据库角色](docs/self-host-configuration.md#database-roles)）。`BETTER_AUTH_SECRET`、`ENCRYPTION_KEY` 与 `SCREEN_PROXY_SECRET` 应各自使用独立的长随机值。Docker 沙箱还需要专属的 `SANDBOX_SUPERVISOR_TOKEN`。你也可以设置 `OPENROUTER_API_KEY`，或在引导过程中连接受支持的模型提供方。

本版本中环境变量仍保留 `RAKAZO_*` 命名，因此已有 `.env` 无需修改即可继续使用。映射关系与改名会影响的范围见[环境变量命名](./docs/MATEBOT_DEPLOY.md#环境变量命名)。

使用 Docker Desktop 进行主机侧开发时，在 `.env` 中设置 `SANDBOX_CONTROL_VIA_LOOPBACK=true`。supervisor 会自动发现 Docker Desktop 的用户 socket；`DOCKER_HOST` 或 `DOCKER_SOCKET` 可覆盖为其他 Docker 运行时。

托管应用目录是可选的。为 Composio 设置 `COMPOSIO_API_KEY`，或为 Pipedream Connect 设置 `PIPEDREAM_CLIENT_ID`、`PIPEDREAM_CLIENT_SECRET` 与 `PIPEDREAM_PROJECT_ID`。不启用任一托管目录时，用户仍可在 **Integrations** 中添加 HTTPS MCP 服务器、Treg 端点或 OpenAPI JSON 文档。连接器凭据在服务端加密，且不会通过 API 返回。

Treg 按用量计费。自托管者需自备 Treg token；把 Treg 嵌入托管产品的运营方应阅读 [Treg 集成条款](https://treg.to/integrate.md)，其中要求托管转售需另行签署书面协议。

```bash
pnpm install
pnpm sandbox:build
pnpm dev
```

`pnpm dev` 在 `DATABASE_URL` 可连接时直接使用该 Postgres；否则用 Docker 启动本地 `rakazo-dev-postgres` 容器，所有检出共用同一个。它会在启动前应用迁移并生成 Prisma 客户端。若某分支带有 main 上不存在的迁移，它会在同一服务器上获得独立数据库，并尽量从共享库复制，避免未合并的 schema 变更混入。默认端口被占用时（例如另一个 git worktree），它会顺延到下一段空闲端口并打印 URL。也可用 `WEB_PORT` 与 `API_PORT` 自行指定端口。

如需改用 Compose 中的 Postgres，可用 `postgres-host` 覆盖文件启动，它在回环地址 `127.0.0.1:5433` 上发布端口，再把 `DATABASE_URL` 与 `DATABASE_MIGRATION_URL` 指向它：

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
```

`POSTGRES_PASSWORD` 需为 URI 安全值（`openssl rand -hex 16`）。已有的 `pgdata` 卷会保留首次初始化时的用户、密码与数据库，因此要么在 `.env` 中保留这些值，要么用 `ALTER ROLE` / 重命名就地修改。只有在备份之后（或数据可丢弃时）才重建该卷；`docker compose down -v` 会删除全部 Postgres 状态。

打开打印出的 URL（默认 [http://127.0.0.1:5173](http://127.0.0.1:5173)），创建账号、连接模型，并创建第一个机器人。

部署、提供商选择、备份与升级见[自托管指南](./docs/self-host.md)、[生产部署](./docs/self-host-production.md)、[备份与恢复](./docs/self-host-backups.md) 与[升级](./docs/self-host-upgrading.md)。

## 桌面与手机

Electron 与 Expo 应用与网页端使用同一个 Matebot API。

开发栈运行后，用以下命令启动 Electron：

```bash
pnpm --filter @matebot/desktop dev
```

首次运行时，桌面应用会询问是在本机运行 Matebot，还是连接已有服务器。**This computer** 会在应用数据目录下用 Docker Compose 安装并启动已发布镜像（与 `infra/compose/install-images.sh` 相同的文件），因此需要安装 Docker Desktop、OrbStack 或 Docker Engine，未安装时应用会给出链接。已安装构建会把镜像标签固定为自己的版本；未打包构建拉取 `edge`。使用 `pnpm dev` 的开发者应改选 **Existing instance** 并填入 `http://127.0.0.1:5173`。公网服务器必须使用 HTTPS；HTTP 仅接受回环与私有局域网地址（不含链路本地地址）。应用在保存前会校验 Matebot 的健康检查端点，之后启动会直接进入该实例。栈在应用退出后继续运行；应用菜单中的 **Stop Local Stack** 可将其关闭。

本地构建 Windows 安装包：

```bash
pnpm --filter @matebot/desktop pack:win
```

输出为 `apps/desktop/out/Matebot-Setup-<version>.exe`：未签名的单用户安装包，安装到 `%LOCALAPPDATA%\Programs\Matebot`，配置保存在 `%APPDATA%\Matebot`（由 Electron 依据 `productName` 推导）。签名与发布由 release 工作流完成，见 [Windows 安装包](./docs/desktop-release.md#windows-installer)。

Linux 桌面应用以 AppImage 形式发布，需要 FUSE 2（`libfuse.so.2`）。若发行版只带 FUSE 3（如 Fedora Silverblue 或 Ubuntu 24.04），会出现 `dlopen(): error loading libfuse.so.2`。请安装 FUSE 2 库（Fedora 上为 `fuse-libs`，Ubuntu 24.04 上为 `libfuse2t64`，较旧的 Ubuntu 与 Debian 上为 `libfuse2`），或在不使用 FUSE 的情况下运行：

```bash
chmod +x Matebot-*.AppImage
./Matebot-*.AppImage --appimage-extract-and-run
```

**This computer** 会查找 `docker` CLI，不检测 Podman。若要尝试其他支持 `compose` 子命令的 Docker 兼容 CLI，请在启动应用前把 `RAKAZO_DOCKER_BINARY` 设为其路径。

用应用菜单中的 **Change Matebot Server…** 重新连接。关闭该窗口而不保存会回到原实例。开发自动化中可用 `RAKAZO_WEB_URL` 把外壳指向别处而不改动已保存实例，或用 `RAKAZO_FORCE_SETUP=1` 重新运行设置。

手机端构建与发布说明见 [docs/mobile-release.md](./docs/mobile-release.md)。

## 从 Rakazo 命名的旧版本升级

早期构建以 Rakazo 为名发布，其桌面配置目录名称不同。桌面应用会在首次启动时把该目录迁移到新位置，因此已保存的服务器、屏幕驱动设置与本地 Compose 栈都会保留。若新旧两个目录同时存在，则以新目录为准，旧目录保持不变。

除此之外无需其他改动：环境变量仍保留 `RAKAZO_*` 命名，数据库角色仍是 `rakazo_app`，Compose 卷沿用原有项目名。

## 界面语言

网页（以及在 Electron 中托管的）界面在 **Settings → Language** 下支持 English、Deutsch、한국어、Türkçe、हिन्दी、Português (Brasil)、简体中文、繁體中文、Español、Русский、Français、עברית、Nederlands 与 日本語。Expo 应用随包提供 English、简体中文、繁體中文、Русский、Deutsch、Nederlands 与 日本語，**Account → Language** 列出全部七种。在用户保存选择之前，设备语言或 `EXPO_PUBLIC_DEFAULT_UI_LOCALE` 仍决定起始语言。

营销主页（`apps/www`）在 `/` 提供简体中文版，其他语言通过页脚语言菜单访问（`/en/`、`/de/`、`/ko/`、`/ja/` 等）；其他营销页面仍为英文。

## 开发

```text
apps/       web、api、worker、desktop、mobile 与公开网站
packages/   领域逻辑、契约、持久化、适配器、UI 与测试工具
infra/      本地服务与计算机镜像
docs/       架构、运维与发布指南
```

工作区包统一为 `@matebot/*`；pnpm 工作区、TypeScript 路径与 Docker 构建过滤器都使用该作用域。

常用检查：

```bash
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

开发流程与测试矩阵见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 文档

- [自托管](./docs/self-host.md)
- [自托管配置](./docs/self-host-configuration.md)
- [自托管密钥](./docs/self-host-secrets.md)
- [登录与账号](./docs/self-host-accounts.md)
- [模型](./docs/self-host-models.md)
- [工具与集成](./docs/self-host-integrations.md)
- [计算机提供商](./docs/self-host-sandbox-providers.md)
- [Docker 计算机](./docs/self-host-docker-computers.md)
- [存储与加密](./docs/self-host-storage.md)
- [生产部署](./docs/self-host-production.md)
- [备份与恢复](./docs/self-host-backups.md)
- [升级](./docs/self-host-upgrading.md)
- [日志与监控](./docs/self-host-observability.md)
- [应用与客户端](./docs/self-host-clients.md)
- [计费](./docs/self-host-billing.md)
- [计算机运行时与隔离](./docs/computer-runtime.md)
- [桌面端发布](./docs/desktop-release.md)
- [移动端发布](./docs/mobile-release.md)
- [性能测试](./docs/performance.md)
- [管理机器人的机器人](./docs/fleet-management.md)

## 与其他产品的比较

- [Grok Bot](https://test.matebot.dev/grok-bot-alternative/)
- [Muse](https://test.matebot.dev/muse-alternative/)
- [Dots](https://test.matebot.dev/dots-alternative/)
- [Instinct](https://test.matebot.dev/instinct-alternative/)
- [OpenClaw](https://test.matebot.dev/openclaw-alternative/)
- [Hermes Agent](https://test.matebot.dev/hermes-alternative/)
- [全部比较](https://test.matebot.dev/alternatives/)

## 致谢

- [PromptLayer](https://promptlayer.com/)
- [Inbox Zero](https://getinboxzero.com/)
- [ConnectorMap](https://connectormap.luinbytes.dev/)
- [CodeRabbit](https://www.coderabbit.ai/)
- [Greptile](https://www.greptile.com/)
- [Snyk](https://snyk.io/)

## 技术栈

- TypeScript
- React 19、Vite 与 Tailwind CSS
- Electron 与 Expo
- Hono 与 oRPC
- PostgreSQL 与 Prisma
- Better Auth
- Graphile Worker
- Pi
- Docker、E2B、Daytona、CreateOS 与 Boat
- Composio、Pipedream Connect、MCP 与 OpenAPI 集成

## 上游

Matebot 跟踪 [elie222/rakazo](https://github.com/elie222/rakazo)。上游 README、演示与商店页面介绍的是上游的托管产品，本 fork 并不运营该服务。想了解或参与 Matebot 所基于的代码，请从该仓库开始。

Matebot 采用 [Apache License 2.0](./LICENSE) 许可，与上游一致。该许可证及其要求的声明保持不变；Matebot 名称与标识属于本 fork。
