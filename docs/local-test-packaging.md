# 本机测试打包（服务端 + Windows；APK 暂停）

这份记录的是 **Linux 主机上给测试栈打热修包** 的做法，不是 GitHub Release。正式发版仍走：

| 产物 | 正式路径 |
| --- | --- |
| 服务端镜像 | [`.github/workflows/publish-server-image.yml`](../.github/workflows/publish-server-image.yml)，说明见 [MATEBOT_DEPLOY.md](./MATEBOT_DEPLOY.md) |
| 已签名桌面安装包 | [`release-desktop`](../.github/workflows/release-desktop.yml)，说明见 [desktop-release.md](./desktop-release.md) |
| Android APK | [`release-android-apk`](../.github/workflows/release-android-apk.yml) / EAS，说明见 [mobile-release.md](./mobile-release.md) |

本机打包 **不** `docker push`、**不** `electron-builder --publish`、**不** 跑 EAS、**不** 改 `apps/desktop/package.json` 的 version。测试安装包沿用当前 Release 号（例如 `0.7.1-pr49.5daee6f29`），文件名用后缀区分构建。

## 何时用这条路

源码 checkout 上有未进 `main` 的改动（可以未提交），要把 API / Web / 桌面一起给测试用户验证。典型约束：

- 桌面 version 字符串不变。Windows 上若已装同一 version，必须先卸载再装，否则会复用旧文件。
- 未签名 NSIS：SmartScreen 会提示，属预期。
- 交互卡片测试栈需要 `FEATURE_A2UI=1`（写在测试 Compose 的 `.env`，不要提交）。
- 主机内存大约 6 GiB 时 **不要** 在本机 Gradle 打 APK，见下文。

## 目录约定

命令里仍用三个变量。接任时先按本机约定赋值；换机器时只改这一张表。

| 变量 | 本机实际位置 | 含义 |
| --- | --- | --- |
| `$SRC` | `/home/lizer05/matebot-src` | 本仓库 checkout（含 `apps/`、`packages/`、`pnpm-lock.yaml`） |
| `$STACK` | `/home/lizer05/matebot-test` | 测试 Compose 目录：`docker-compose.images.yml`、`docker-compose.override.yml`、`.env`。项目名是 `matebottest`。数据库在 **外部** Postgres 容器里，override 不得删掉它 |
| `$DOWNLOADS` | `/home/lizer05/matebot/www-dist/downloads` | 对外分发的 Windows 测试安装包目录 |

测试栈用 `SANDBOX_PROVIDER=docker`、外部网络接现有 Postgres。`up` 时不要带会重建数据库卷的参数。

### Windows 安装包落盘位置

electron-builder 先写到 `$SRC/apps/desktop/out/`（Wine 容器常以 root 写出；打完验收后应删 `win-unpacked`，不要把这里当下载点）。

对外只保留 **一份** 当前测试 exe，放在营销站静态目录，不进 git：

| 角色 | 路径 |
| --- | --- |
| 宿主机文件 | `/home/lizer05/matebot/www-dist/downloads/Matebot-Setup-<version>-<构建标记>.exe` |
| 反向代理配置 | `/home/lizer05/matebot/cf-proxy/nginx.conf` 里 `server_name test.matebot.dev` 的 `location = /api/download` |
| 容器内别名 | `matebot-cf-proxy` 把 `www-dist` 挂到 `/var/www/matebot`，因此 `/downloads/` = 上面那个宿主机目录 |
| 下载 URL | `https://test.matebot.dev/api/download?platform=windows` → 302 到 `/downloads/Matebot-Setup-….exe` |

当前对外文件（2026-11-13 日历草稿热修）：

```text
/home/lizer05/matebot/www-dist/downloads/Matebot-Setup-0.7.1-pr49.5daee6f29-cal.exe
```

换新包时：复制新 exe 到 `$DOWNLOADS`、改 nginx 里那一行 302、`docker exec matebot-cf-proxy nginx -s reload`、删掉被替换的旧 exe。用 `Host: test.matebot.dev` 测跳转；对 `127.0.0.1` 不带 Host 会落到产品默认 server，不是营销站。

---

## 1. 服务端镜像（增量）

lockfile 相对正在跑的 `app` 镜像没变时，不要从 [`infra/compose/Dockerfile`](../infra/compose/Dockerfile) 冷构建。从 **当前测试栈正在用的 app 镜像** 复制源码再编译即可（node_modules 留在父镜像里）。

1. 记下正在跑的标签，例如 `$STACK/.env` 里的 `MATEBOT_IMAGE_TAG`。
2. 写一个一次性 Dockerfile（不要提交；可放 `/tmp`）：

```dockerfile
FROM ghcr.io/lizer2009/matebot/app:<当前正在跑的标签>
USER root
WORKDIR /app
COPY --chmod=755 . .
RUN pnpm --filter @matebot/db generate
RUN pnpm --filter @matebot/api --filter @matebot/worker build
RUN MATEBOT_ALLOW_DEV_SECRETS=1 pnpm --filter @matebot/web build
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
USER node
CMD ["pnpm", "--filter", "@matebot/api", "start"]
```

3. 新标签用 `sha-<短 SHA>-<用途>`，例如 `sha-8645af35-cards`，**不要覆盖** 正在跑的旧标签，方便回滚。

```bash
cd "$SRC"
NEW_TAG="sha-$(git rev-parse --short=8 HEAD)-cards"
docker build \
  -f /tmp/matebot-rebuild.Dockerfile \
  --build-arg "GIT_SHA=$(git rev-parse HEAD)-cards" \
  -t "ghcr.io/lizer2009/matebot/app:${NEW_TAG}" \
  .
```

`COPY . .` 受 [`.dockerignore`](../.dockerignore) 约束：`node_modules`、`.env`、dump 不会进镜像。未跟踪的说明文档会进去，不影响运行。

4. 改 `$STACK/.env` 的 `MATEBOT_IMAGE_TAG=$NEW_TAG`（只改 tag，不要改仓库名），然后只拉起应用进程：

```bash
cd "$STACK"
docker compose --env-file .env \
  -f docker-compose.images.yml \
  -f docker-compose.override.yml \
  up -d api web worker supervisor
```

无 Prisma 迁移时不必动 `migrate` / Postgres。有迁移时再带上 compose 文件里的 `migrate` 服务，且仍不要重建外部数据库卷。

5. 确认容器镜像标签与 `GIT_SHA`，并打一次健康检查（本机 Web 入口端口以 override 为准）。

回滚：把 `MATEBOT_IMAGE_TAG` 改回上一个仍留在本机的标签，再 `up -d` 那四个服务。

---

## 2. Windows 安装包（Linux 交叉编译）

正式包必须在 **Windows runner** 上打（[`desktop-windows-installer.yml`](../.github/workflows/desktop-windows-installer.yml)），否则会打进 Linux 的 Koffi。本机用 Wine 只为出一份 **测试用** 未签名安装包。

### 2.1 先放进 Windows 原生模块

pnpm 在 Linux 上只会装 `koffi-linux-*`。交叉打包前把 Windows 模块放到 koffi 旁边：

```bash
KOFFI_VER=3.3.4
DEST="$SRC/node_modules/.pnpm/koffi@${KOFFI_VER}/node_modules/@koromix/koffi-win32-x64"
mkdir -p "$DEST" /tmp/koffi-win && cd /tmp/koffi-win
curl -fsSL -o koffi-win32-x64.tgz \
  "https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-${KOFFI_VER}.tgz"
tar -xzf koffi-win32-x64.tgz
cp -a package/. "$DEST/"
test -f "$DEST/win32_x64/koffi.node"
```

版本号必须与 `apps/desktop/package.json` 里的 `koffi` 一致。

### 2.2 构建 Web 与主进程，再用 Wine 跑 NSIS

主机不一定装得了 `wine32`（需要 sudo）。用 `electronuserland/builder:wine`：

```bash
cd "$SRC"
pnpm --filter @matebot/web build
pnpm --filter @matebot/desktop build

# 上次构建产物若是 root 所有，先清掉，否则 electron-builder 写不进去
docker run --rm -v "$SRC/apps/desktop/out:/out" busybox:1 rm -rf /out/win-unpacked

mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
docker pull electronuserland/builder:wine
docker run --rm \
  --env CSC_IDENTITY_AUTO_DISCOVERY=false \
  --env ELECTRON_CACHE=/root/.cache/electron \
  --env ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
  -v "$SRC:/project" \
  -v "$HOME/.cache/electron:/root/.cache/electron" \
  -v "$HOME/.cache/electron-builder:/root/.cache/electron-builder" \
  electronuserland/builder:wine \
  bash -lc 'cd /project/apps/desktop && ./node_modules/.bin/electron-builder --win --x64 --publish never "-c.win.signExecutable=false"'
```

`-c.win.signExecutable=false` 必须整段加引号（PowerShell 会在点号处拆开）。`--publish never` 防止误发 GitHub Release。

### 2.3 验收原生模块后再分发

```bash
ROOT="$SRC/apps/desktop/out/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix"
test -f "$ROOT/koffi-win32-x64/win32_x64/koffi.node"
# 不得只剩 koffi-linux-*；否则 Windows 启动报 Cannot find the native Koffi module
```

通过后复制到下载目录（version 保持 package.json，后缀标这次构建）。本机 `$DOWNLOADS` 就是 `/home/lizer05/matebot/www-dist/downloads`：

```bash
VER=$(python3 -c "import json; print(json.load(open('$SRC/apps/desktop/package.json'))['version'])")
MARK=cal   # 本次构建标记，例如 ux / cal
cp -f "$SRC/apps/desktop/out/Matebot-Setup-${VER}.exe" \
  "$DOWNLOADS/Matebot-Setup-${VER}-${MARK}.exe"
```

改 `/home/lizer05/matebot/cf-proxy/nginx.conf` 里 `platform=windows` 的 302 目标为新文件名，然后：

```bash
docker exec matebot-cf-proxy nginx -t
docker exec matebot-cf-proxy nginx -s reload
curl -sI -H 'Host: test.matebot.dev' \
  'http://127.0.0.1/api/download?platform=windows'
```

`Location` 应指向 `/downloads/Matebot-Setup-${VER}-${MARK}.exe`。确认后再删 `$DOWNLOADS` 里被替换的旧 exe。

测试者：先卸载已装的同一 version，再装新包。不卸载时 Windows 常复用旧的 `app.asar`。

---

## 3. Android APK：本机暂停，改走 CI

### 为什么停

在约 6 GiB 内存的 Linux 主机上，用 Node+JDK 容器跑 `./gradlew :app:assembleRelease` 两次都失败：

1. 约 50 分钟后 `Gradle build daemon disappeared unexpectedly`（CMake / Kotlin 阶段 OOM）。
2. 降到 `-Xmx1024m`、`--no-daemon`、`org.gradle.workers.max=1`、`CMAKE_BUILD_PARALLEL_LEVEL=1` 后，卡在 `:react-native-vector-icons_ionicons:compileReleaseKotlin FAILED`，之后 Gradle 空转约 2 小时（CPU ~2%、容器内存约 100 MiB），没有 APK。

本机这条路不作为接任默认。要装测试 APK：打 `android-pr*` 标签或在 `main` 上跑 [`release-android-apk`](../.github/workflows/release-android-apk.yml)（见 [mobile-release.md](./mobile-release.md)）。那会替换滚动 `android` Release，**不要**为一次分支热修去动它，除非明确要覆盖现网 APK。

### 若必须再试本机 Gradle

不要在宿主机装 JDK。容器绑定源码、SDK 卷、Gradle 卷；ARM 只打 `arm64-v8a`。脚本大意：

```bash
docker volume create matebot-android-sdk
docker volume create matebot-gradle-home
docker run --rm \
  -v matebot-android-sdk:/opt/android-sdk \
  -v matebot-gradle-home:/root/.gradle \
  -v "$SRC:/src" \
  -e CI=1 \
  -e CMAKE_BUILD_PARALLEL_LEVEL=1 \
  node:24.22.1-bookworm \
  bash /build-apk.sh
```

`/build-apk.sh` 负责：安装 `openjdk-17-jdk-headless`、把 cmdline-tools / platform 放进 `/opt/android-sdk`、在 `apps/mobile/android` 执行：

```text
./gradlew :app:assembleRelease --no-daemon \
  -PreactNativeArchitectures=arm64-v8a \
  -Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=256m -XX:+HeapDumpOnOutOfMemoryError \
  -Dorg.gradle.workers.max=1 -Dorg.gradle.parallel=false --console=plain
```

### 判定卡死并停掉

日志停在某个 `FAILED` 之后长时间没有新 `> Task`，且 `docker stats` 里该容器 CPU 接近 0：视为卡死。

```bash
docker ps --filter ancestor=node:24.22.1-bookworm
docker stop --timeout 20 <container>
```

`docker run --rm` 停掉后容器会删掉。不要 `docker kill` 测试栈里的 `matebottest-*`。

### 失败后要清的文件

容器以 root 写在 bind-mount 上，宿主机用户删不掉时用 busybox：

```bash
docker run --rm -v "$SRC:/src" busybox:1 sh -c '
  rm -f /src/apps/mobile/android/java_pid*.hprof
  rm -rf /src/apps/mobile/android/app/build \
         /src/apps/mobile/android/build \
         /src/apps/mobile/android/.gradle \
         /src/apps/mobile/android/app/.cxx \
         /src/apps/mobile/modules/*/android/build
  find /src/node_modules/.pnpm -type d \
    \( -path "*/android/build" -o -path "*/android/.cxx" \) -prune -exec rm -rf {} +
'
rm -f /tmp/matebot-build-apk.sh
```

**保留** named volume `matebot-android-sdk` 和 `matebot-gradle-home`（重下 SDK 很慢）。只有确定不再打本机 APK 时才 `docker volume rm` 它们。

---

## 4. 打完后清磁盘

主机根分区往往只剩几 GiB。打包结束后立刻清，不要等下次 OOM。

| 清 | 留 |
| --- | --- |
| `electronuserland/builder:wine`（`docker rmi`） | 正在跑的 `matebottest-*` 所用 `app` 标签 |
| `$SRC/apps/desktop/out/win-unpacked/`（root 时用 busybox 删） | 当前要分发的那一个 `Matebot-Setup-*.exe` |
| `$DOWNLOADS` 里被新包替换的旧 exe | computer 镜像（测试栈 bot 桌面） |
| 已切换走的上一档 `app:sha-…` 标签（确认 `docker ps` 没有引用） | `matebot-android-sdk` / `matebot-gradle-home`（若还打算打 APK） |
| APK 失败留下的 `*.hprof`、`android/build`、`android/.cxx` | 外部 Postgres 与其数据卷 |

不要 `docker system prune` / `docker image prune -a`：会误删 computer 镜像和尚未切走的 app 标签。

```bash
# 例：应用已切到 sha-…-cards 后，删上一档增量镜像
docker rmi ghcr.io/lizer2009/matebot/app:sha-<上一档>
docker rmi electronuserland/builder:wine || true
docker run --rm -v "$SRC/apps/desktop/out:/out" busybox:1 rm -rf /out/win-unpacked
df -h /
```

---

## 5. 不要做的事

- 不把本机测试镜像 `docker push` 到 GHCR。
- 不把未签名安装包发到 GitHub Release；正式 Windows 包只来自 `release-desktop`。
- 不为一次分支热修去跑 `release-android-apk`（会覆盖滚动 `android` 下载）。
- 不提交 `.env`、`docs/architecture/tool-tiers.md`（若仍未纳入产品）、heap dump、`win-unpacked`。
- 不改桌面 version 来「区分测试包」；用文件名后缀，并让测试者卸载重装。

## 相关文档

- [MATEBOT_DEPLOY.md](./MATEBOT_DEPLOY.md) — 测试 / 局域网 Compose 与 GHCR 发布
- [desktop-release.md](./desktop-release.md) — 签名桌面发版与 Windows runner 安装包
- [mobile-release.md](./mobile-release.md) — EAS / 滚动 APK
- [self-host.md](./self-host.md) — 自托管总览
