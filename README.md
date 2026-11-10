# Matebot

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

**Matebot** is a self-hosted AI teammate you own: persistent bots that use a real computer, work on
a schedule, and keep their memory and history across the web, desktop, and phone clients. It runs on
your own server, with your own model credentials, and needs no local desktop to operate.

This repository is a fork of **[Matebot](https://github.com/elie222/rakazo)**, the Apache-2.0 project
it is built on. Matebot keeps that licence, its notices, and a clear attribution to upstream; the
differences are the product name, the packaging, and the deployment this fork runs.

| | |
| --- | --- |
| **This deployment** | https://test.matebot.dev |
| **Fork plan and status** | [docs/MATEBOT_PLAN.md](./docs/MATEBOT_PLAN.md) |
| **Deployment notes** | [docs/MATEBOT_DEPLOY.md](./docs/MATEBOT_DEPLOY.md) |
| **Cursor Cloud Agent** | [docs/MATEBOT_CURSOR.md](./docs/MATEBOT_CURSOR.md) |
| **Brand assets** | [docs/MATEBOT_BRAND.md](./docs/MATEBOT_BRAND.md) |
| **Windows installer** | [docs/desktop-release.md](./docs/desktop-release.md) |

## Features

- Persistent bots with their own conversations, memory, routines, and history
- Voice mode: speak replies, dictate, and call a bot. Bring your own ElevenLabs, OpenAI, Cartesia, or Fish Audio key, or use a Mac server's installed voices
- Shared Team Computers and isolated Private computers
- Browser, terminal, file, and graphical desktop access
- Bots that can delegate to peer bots or short-lived subagents
- Bring-your-own model credentials through Pi
- App integrations through Composio or Pipedream Connect, plus user-installed Treg, remote MCP, and OpenAPI tool sources
- Docker, E2B, Daytona, CreateOS, Boat, and trusted local-computer support

## Quick start (published images)

You need Docker Engine, the Compose plugin, curl, and OpenSSL. No clone or Node install.

```bash
mkdir -p matebot && cd matebot &&
curl -fsSLO https://raw.githubusercontent.com/Lizer2009/matebot/main/infra/compose/install-images-matebot.sh &&
bash install-images-matebot.sh
```

The installer downloads the Compose files, creates `.env` with random secrets, and starts Matebot.
It preserves an existing `.env` when rerun.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), create an account, and connect a model.
Local Docker computers are on by default. Optional remote providers: `e2b`, `novita`, `daytona`, `createos`, `boat`, `boxd`, or `railway`
with the matching API key.

Images come from this fork's registry, `ghcr.io/lizer2009/matebot/{app,computer,updater}`, tagged
`edge` for main builds and `sha-<commit>` per commit. Details:
[self-hosting guide](./docs/self-host.md#published-images-no-checkout).

Upstream's installer (`install-images.sh`) still works and pulls upstream images; use it only when
you deliberately want upstream's build.

On restricted networks, override the installer download base (`MATEBOT_DOWNLOAD_BASE`), skip
existing Compose files (`--local` / `MATEBOT_DOWNLOAD_SKIP_EXISTING`), or mirror the bootstrap
script URL — see
[Restricted networks / mirror downloads](./docs/self-host.md#restricted-networks--mirror-downloads).

For an agent-assisted install, use [SETUP_PROMPT.md](./SETUP_PROMPT.md).

## Run on a server

Bots stay on when the backend runs on a server. Use the same installer on a VPS, then connect from
the desktop app, the mobile app, or a browser.

```bash
bash install-images-matebot.sh --prepare-only
# edit .env: SANDBOX_PROVIDER=boat (or e2b / daytona / createos) with its API key, MATEBOT_HOST=your.domain
bash install-images-matebot.sh
```

Put HTTPS in front of port 5173; [docs/self-host-production.md](./docs/self-host-production.md#public-single-vm-deployment)
covers the Caddy setup and host hardening. In the desktop app choose **Existing instance** and enter
the `https://` address.

## Local development (source checkout)

You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+;
pnpm 9; and Docker. Node.js 23.x and 25.x are not supported.

```bash
git clone https://github.com/Lizer2009/matebot.git
cd matebot
cp .env.example .env
```

Set `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` to two values from `openssl rand -hex 16`,
then put them in `DATABASE_MIGRATION_URL` and `DATABASE_URL`. The app connects as its own
`matebot_app` login, which row-level security applies to; migrations run as the owner
([database roles](docs/self-host-configuration.md#database-roles)). Set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to
independent long random values. Docker sandboxes also need a dedicated
`SANDBOX_SUPERVISOR_TOKEN`. You can also set `OPENROUTER_API_KEY`, or connect a supported
model provider during onboarding.

Environment variables keep their `RAKAZO_*` names in this release, so an existing `.env` keeps
working unchanged. See [configuration names](./docs/MATEBOT_DEPLOY.md#环境变量命名) for the mapping
and what a rename would touch.

For host-side development with Docker Desktop, set `SANDBOX_CONTROL_VIA_LOOPBACK=true`
in `.env`. The supervisor discovers Docker Desktop's user socket automatically;
`DOCKER_HOST` or `DOCKER_SOCKET` can override it for another Docker runtime.

Managed app catalogs are optional. Set `COMPOSIO_API_KEY` for Composio, or the
`PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, and `PIPEDREAM_PROJECT_ID` trio for Pipedream
Connect. Users can add an HTTPS MCP server, Treg endpoint, or OpenAPI JSON document from
**Integrations** without enabling either managed catalog. Connector credentials are encrypted on the
server and are never returned by the API.

Treg is usage-metered. Self-hosters supply their own Treg token; operators embedding Treg in a
hosted product should review [Treg's integration terms](https://treg.to/integrate.md), which require
a written agreement for hosted resale.

```bash
pnpm install
pnpm sandbox:build
pnpm dev
```

`pnpm dev` uses the Postgres in `DATABASE_URL` when it accepts a connection. Otherwise it starts a
local `matebot-dev-postgres` container with Docker, and every checkout reuses that one. It applies
migrations and generates the Prisma client before starting. A branch that adds migrations main
doesn't have gets its own database on the same server, copied from the shared one when possible,
so unmerged schema changes stay out of it. When the default ports are taken, for example by
another git worktree, it moves to the next free block and prints the URL. Set `WEB_PORT` and
`API_PORT` to choose ports yourself.

To run Postgres from the Compose file instead, start it with the `postgres-host` overlay, which
publishes loopback `127.0.0.1:5433`, and point `DATABASE_URL` and `DATABASE_MIGRATION_URL` at it:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
```

Use a URI-safe `POSTGRES_PASSWORD` (`openssl rand -hex 16`). An existing `pgdata` volume keeps the
user, password, and database from first init, so keep those values in `.env`, or change them in
place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when the data is
disposable); `docker compose down -v` deletes all Postgres state.

Open the printed URL ([http://127.0.0.1:5173](http://127.0.0.1:5173) by default), create an account, connect a model, and create
your first bot.

For deployment, provider selection, backups, and upgrades, see the
[self-hosting guide](./docs/self-host.md), [production deployment](./docs/self-host-production.md),
[backup and restore](./docs/self-host-backups.md), and [upgrading](./docs/self-host-upgrading.md).

To use CreateOS, set `SANDBOX_PROVIDER=createos` and `CREATEOS_SANDBOX_API_KEY`.
Optional `CREATEOS_SANDBOX_BASE_URL`, `CREATEOS_SANDBOX_SHAPE`, and
`CREATEOS_SANDBOX_ROOTFS` default to `https://api.sb.createos.sh`, `s-2vcpu-2gb`,
and `desktop:1`.

To use Railway computers, set `SANDBOX_PROVIDER=railway`, `RAILWAY_API_TOKEN`
and `RAILWAY_ENVIRONMENT_ID` on the API and worker. Choose the sandbox environment
explicitly; Railway's automatic environment ID identifies the hosted app's environment.
Use the narrowest Railway API token that works: prefer a project token if sufficient
for sandbox operations and supported by the client's authentication. This provider
currently uses bearer authentication, so use a team/workspace token rather than a
personal account token.
The live screen and desktop require `PRIVATE` networking so Railway's public domain
can serve the screen. Computers use this mode and can reach other services in the
same Railway project/environment, as well as the public internet. We recommend a
dedicated Railway project (or at least a separate environment) for sandboxes,
separate from the app and database. Recreate existing `ISOLATED` computers before use.
The desktop is installed on first start. Stopping a computer saves its portable
home and destroys the sandbox; the next start restores that home in a new sandbox.
Railway sandbox usage is metered.
New computers start in Railway's default region. Set `RAILWAY_SANDBOX_REGION` (for example
`asia-southeast1-eqsg3a`) to keep them near the API; a running computer moves on its next start.
Workspace exports reject files above 64 MiB without truncating them. Set `RAILWAY_MAX_WORKSPACE_FILE_BYTES` to change this limit.

## Desktop and mobile

The Electron and Expo apps are clients of the same Matebot API used by the web app.

With the development stack running, launch Electron with:

```bash
pnpm --filter @matebot/desktop dev
```

On first run the desktop app asks whether to run Matebot on this computer or connect to an existing
server. **This computer** installs and starts the published images with Docker Compose (the same
files as `infra/compose/install-images.sh`) under the app's data directory, so Docker Desktop,
OrbStack, or Docker Engine must be installed; the app links to them when it is not. Installed
builds pin the image tag to their own version; unpackaged builds pull `edge`. Developers running
`pnpm dev` should pick **Existing instance** with `http://127.0.0.1:5173` instead. Public servers
must use HTTPS; HTTP is accepted only for loopback and private LAN addresses (not link-local). The
app verifies Matebot's health endpoint before saving, and later launches go straight to that
instance. The stack keeps running after the app quits; **Stop Local Stack** in the application
menu turns it off.

To build the Windows installer locally:

```bash
pnpm --filter @matebot/desktop pack:win
```

That writes `apps/desktop/out/Matebot-Setup-<version>.exe`, an unsigned per-user installer that
installs under `%LOCALAPPDATA%\Programs\Matebot` and keeps its profile in `%APPDATA%\Matebot`,
which is what Electron derives from `productName`.
Signing and publishing run in the release workflow. See
[Windows installer](./docs/desktop-release.md#windows-installer).

On Linux the desktop app ships as an AppImage, which needs FUSE 2 (`libfuse.so.2`). Distributions
that only include FUSE 3, such as Fedora Silverblue or Ubuntu 24.04, show
`dlopen(): error loading libfuse.so.2`. Install the FUSE 2 library (`fuse-libs` on Fedora,
`libfuse2t64` on Ubuntu 24.04, `libfuse2` on older Ubuntu and Debian), or run the AppImage without
FUSE:

```bash
chmod +x Matebot-*.AppImage
./Matebot-*.AppImage --appimage-extract-and-run
```

**This computer** looks for the `docker` CLI and does not detect Podman. To try another
Docker-compatible CLI that supports the `compose` commands, set `MATEBOT_DOCKER_BINARY` to its path
before starting the app.

Use **Change Matebot Server…** in the application menu to reconnect. Closing that window without
saving returns to the previous instance. For development automation, set `MATEBOT_WEB_URL` to point
the shell somewhere else without changing the saved instance, or `MATEBOT_FORCE_SETUP=1` to run
setup again.

Mobile build and release instructions live in [docs/mobile-release.md](./docs/mobile-release.md).

## Upgrading from the Matebot-named build

Earlier builds shipped as Matebot, so their desktop profile lived in a differently named folder. The
desktop app moves that profile into its new location on first launch, so your saved server, screen
driver setup, and local Compose stack carry over. If both folders exist, the new one wins and the old
one is left alone.

Nothing else needs to change: environment variables keep their `RAKAZO_*` names, the database role
is still `matebot_app`, and Compose volumes keep their existing project names.

## UI language

The web (and Electron-hosted) UI supports English, Deutsch, 한국어, Türkçe, हिन्दी,
Português (Brasil), 简体中文, 繁體中文, Español, Русский, Français, עברית, Nederlands, and 日本語 under
**Settings → Language**. The Expo app ships English, 简体中文, 繁體中文, Русский, Deutsch,
Nederlands, and 日本語 catalogs, and **Account → Language** lists all seven. A device language or
`EXPO_PUBLIC_DEFAULT_UI_LOCALE` still selects the starting catalog before a saved choice.
The marketing
homepage (`apps/www`) is served in Simplified Chinese at `/`, with every other language in the
footer's language menu (`/en/`, `/de/`, `/ko/`, `/ja/`, ...); other marketing pages stay English.

## Development

```text
apps/       web, api, worker, desktop, mobile, and public website
packages/   domain, contracts, persistence, adapters, UI, and test tooling
infra/      local services and computer images
docs/       architecture, operations, and release guides
```

Workspace packages are `@matebot/*`; the pnpm workspace, TypeScript paths, and Docker build filters
all use that scope.

Common checks:

```bash
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and test matrix.

## Documentation

- [Self-hosting](./docs/self-host.md)
- [Self-host configuration](./docs/self-host-configuration.md)
- [Self-host secrets](./docs/self-host-secrets.md)
- [Sign-in and accounts](./docs/self-host-accounts.md)
- [Models](./docs/self-host-models.md)
- [Tools and integrations](./docs/self-host-integrations.md)
- [Computer providers](./docs/self-host-sandbox-providers.md)
- [Docker computers](./docs/self-host-docker-computers.md)
- [Storage and encryption](./docs/self-host-storage.md)
- [Production deployment](./docs/self-host-production.md)
- [Backup and restore](./docs/self-host-backups.md)
- [Upgrading](./docs/self-host-upgrading.md)
- [Logs and monitoring](./docs/self-host-observability.md)
- [Apps and clients](./docs/self-host-clients.md)
- [Billing](./docs/self-host-billing.md)
- [Computer runtime and isolation](./docs/computer-runtime.md)
- [Desktop releases](./docs/desktop-release.md)
- [Mobile releases](./docs/mobile-release.md)
- [Performance testing](./docs/performance.md)
- [Bots that manage bots](./docs/fleet-management.md)

## How Matebot compares

- [Grok Bot](https://test.matebot.dev/grok-bot-alternative/)
- [Muse](https://test.matebot.dev/muse-alternative/)
- [Dots](https://test.matebot.dev/dots-alternative/)
- [Instinct](https://test.matebot.dev/instinct-alternative/)
- [OpenClaw](https://test.matebot.dev/openclaw-alternative/)
- [Hermes Agent](https://test.matebot.dev/hermes-alternative/)
- [All comparisons](https://test.matebot.dev/alternatives/)

## Thanks

- [PromptLayer](https://promptlayer.com/)
- [Inbox Zero](https://getinboxzero.com/)
- [ConnectorMap](https://connectormap.luinbytes.dev/)
- [CodeRabbit](https://www.coderabbit.ai/)
- [Greptile](https://www.greptile.com/)
- [Snyk](https://snyk.io/)

## Stack

- TypeScript
- React 19, Vite, and Tailwind CSS
- Electron and Expo
- Hono and oRPC
- PostgreSQL and Prisma
- Better Auth
- Graphile Worker
- Pi
- Docker, E2B, Daytona, CreateOS, and Boat
- Composio, Pipedream Connect, MCP, and OpenAPI integrations

## Upstream

Matebot tracks [Lizer2009/matebot](https://github.com/elie222/rakazo). The upstream README, its demo,
and its store listings describe upstream's hosted product, which this fork does not operate. To
follow or contribute to the code Matebot builds on, start at that repository.

Matebot is licensed under the [Apache License 2.0](./LICENSE), the same licence as upstream. That
licence and the notices it requires stay in place; the Matebot name and marks are this fork's.
