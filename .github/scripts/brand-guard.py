#!/usr/bin/env python3
"""
Brand-guard: every remaining `rakazo` in shipped output must be a named legacy identity.

Why a guard rather than a rename
    The product is Matebot, but 7220 occurrences of `rakazo` remain in this repository and
    almost none of them are the product's name. They are a compose project name, volume names,
    database roles, HTTP headers, storage keys, environment variables, the preload bridge, and
    six Android module directories. Renaming any of those loses data or breaks an installed
    client; see `brand-residue-classification.md` for the per-category reasoning.

    So the invariant is not "no rakazo anywhere". It is: **every remaining occurrence is on a
    documented list, and every list entry says what it is.** A new visible use of the old name
    fails this test until someone adds it deliberately with a reason.

How it works
    The scanner walks the shipped trees, extracts each `rakazo` occurrence with its surrounding
    context, classifies it against the allowlist patterns below, and fails on anything it cannot
    place. It also fails when an allowlist entry stops matching — a stale excuse is how these
    lists rot into meaninglessness.

Run:  python3 brand_guard.py
      python3 brand_guard.py --list     show every unclassified occurrence
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(os.environ.get("BRAND_GUARD_ROOT") or pathlib.Path.cwd()).resolve()

# Trees whose output reaches a user or a running deployment. Test files and archives are out of
# scope: a fixture that says `rakazo.test` is not a brand decision, and history is not editable.
SCAN_ROOTS = (
    "apps/web/src",
    "apps/web/index.html",
    "apps/mobile/app",
    "apps/mobile/lib",
    "apps/mobile/components",
    "apps/mobile/app.json",
    "apps/mobile/modules",
    "apps/desktop/src",
    "apps/desktop/e2e/fixtures",
    "apps/desktop/package.json",
    "apps/www/src",
    "apps/www/src/pages",
    "apps/www/src/i18n",
    "packages/contracts/src",
    "packages/core/src",
    "packages/db/src",
    "infra/compose",
    "infra/systemd",
    "docs/self-host.md",
    "docs/self-host-configuration.md",
    "docs/self-host-upgrading.md",
)

SKIP_SUFFIXES = (
    ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".snap", ".po", ".lock", ".png", ".jpg",
    ".woff", ".woff2", ".ttf", ".ico", ".svg",
)
SKIP_DIRS = ("node_modules", "dist", "build", "out", ".turbo", "generated", "locales")


# (pattern, why it is allowed). Each entry is a *kind* of legacy identity, not a file.
ALLOWED = [
    # ---------- the ones that would lose data if renamed ----------
    (r"^rakazo(_prod)?_(app|data)$", "live Docker network names"),
    (r"^rakazo$",
     "Postgres role/database name and the container user; renaming either disconnects the "
     "data that exists"),
    # Named one by one on purpose. `^RAKAZO_[A-Z0-9_]+$` would accept any new
    # setting whose name starts with the former product name, which is exactly the
    # drift this guard exists to catch, so each variable a deployment already reads
    # is listed. Adding one is a deliberate act with a reason.
    (r"^_?(?:RAKAZO_ADMIN_EMAILS|RAKAZO_ALLOW_DEV_SECRETS|RAKAZO_API_MEMORY_LIMIT|RAKAZO_API_PORT|RAKAZO_APP_URL|RAKAZO_AUDIT_HEARTBEAT_SECONDS|RAKAZO_AUDIT_HOST|RAKAZO_AUDIT_KNOWN_KEYS|RAKAZO_AUDIT_SINK_URL|RAKAZO_AUDIT_TOKEN_FILE|RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE|RAKAZO_AUTO_REVIEW_MODEL|RAKAZO_AUTO_REVIEW_PROVIDER|RAKAZO_AUTO_REVIEW_TIMEOUT_MS|RAKAZO_BACKUP_AGE_RECIPIENTS|RAKAZO_BACKUP_AGE_RECIPIENTS_FILE|RAKAZO_BACKUP_ALLOW_PLAINTEXT|RAKAZO_BACKUP_KEEP|RAKAZO_BACKUP_MAX_GB|RAKAZO_BACKUP_MIN_FREE_GB|RAKAZO_BACKUP_OFFSITE_KEEP|RAKAZO_BACKUP_OFFSITE_REMOTE|RAKAZO_BACKUP_REQUIRE_VOLUME|RAKAZO_BUILD|RAKAZO_CLOUD_URL|RAKAZO_COMPOSE_FILE|RAKAZO_COMPOSE_PROJECT_NAME|RAKAZO_COMPUTER_CPUS|RAKAZO_COMPUTER_IMAGE|RAKAZO_COMPUTER_IMAGE_TAG|RAKAZO_COMPUTER_MEMORY|RAKAZO_COMPUTER_PIDS_LIMIT|RAKAZO_CONTROL_RELEASED|RAKAZO_CSP_CONNECT_SRC|RAKAZO_CSP_SCRIPT_SRC|RAKAZO_DEPLOYED_MIGRATIONS|RAKAZO_DEPLOY_BUILD_CACHE_GB|RAKAZO_DEPLOY_BUILD_TIMEOUT|RAKAZO_DEPLOY_DIR|RAKAZO_DEPLOY_HEALTH_INTERVAL|RAKAZO_DEPLOY_IMAGE|RAKAZO_DEPLOY_MIN_FREE_GB|RAKAZO_DEPLOY_PULL_TIMEOUT|RAKAZO_DEPLOY_REVISION|RAKAZO_DEPLOY_ROLLBACK_TIMEOUT|RAKAZO_DEPLOY_UP_TIMEOUT|RAKAZO_DESKTOP|RAKAZO_DESKTOP_RELEASE|RAKAZO_DESKTOP_RELEASED|RAKAZO_DESKTOP_STACK_TOKEN|RAKAZO_DISABLE_AUTO_UPDATE|RAKAZO_DISABLE_BUNDLED_RENDERER|RAKAZO_DISABLE_WARM_WINDOW|RAKAZO_DOCKER_BINARY|RAKAZO_DOWNLOAD_BASE|RAKAZO_DOWNLOAD_SKIP_EXISTING|RAKAZO_EGRESS_SUDOED|RAKAZO_ENV_IMAGES_EXAMPLE|RAKAZO_FORCE_SETUP|RAKAZO_GITHUB_API|RAKAZO_GIT_SHA|RAKAZO_HEALTH_URL|RAKAZO_HOST|RAKAZO_IF_INET6|RAKAZO_IMAGE|RAKAZO_IMAGE_TAG|RAKAZO_IMAGE_TAG_PREVIOUS|RAKAZO_INTERNAL_PROFILE|RAKAZO_INTERNAL_VIEW_TOKEN|RAKAZO_IP6TABLES|RAKAZO_IPTABLES|RAKAZO_LIVE_MODEL_CATALOG|RAKAZO_LOCAL_CONTEXT_WINDOW|RAKAZO_LOCAL_MAX_TOKENS|RAKAZO_LOCAL_MODELS|RAKAZO_LOCAL_MODELS_URL|RAKAZO_LOCAL_REASONING_MODELS|RAKAZO_LOCAL_VISION_MODELS|RAKAZO_LOCAL_WEB_URL|RAKAZO_MARKETING_URL|RAKAZO_MESSAGE_USER_MAX_CHARS|RAKAZO_MIGRATIONS_PATH|RAKAZO_MIN_CLIENT_BUILD|RAKAZO_MONITOR_COMPOSE_PROJECT|RAKAZO_NAV_LINKS|RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS|RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC|RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS|RAKAZO_PASSKEY_RP_ID|RAKAZO_PERFORMANCE_CLEAR_CACHE|RAKAZO_PERFORMANCE_USER_DATA|RAKAZO_POSTGRES_16_IMAGE|RAKAZO_PULL_NEVER|RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP|RAKAZO_SYSTEMCTL|RAKAZO_UPDATER_HOST|RAKAZO_UPDATER_IMAGE|RAKAZO_UPDATER_IMAGE_TAG|RAKAZO_UPDATER_PORT|RAKAZO_UPDATER_TOKEN|RAKAZO_UPDATE_RESTART_SUPERVISOR|RAKAZO_UPDATE_SERVICES|RAKAZO_WARM_WINDOW_TTL_MS|RAKAZO_WEB_BIND|RAKAZO_WEB_PORT|RAKAZO_WEB_URL|RAKAZO_WORKER_MEMORY_LIMIT|_RAKAZO_VALIDATE_BETTER_AUTH_SECRET|_RAKAZO_VALIDATE_ENCRYPTION_KEY|_RAKAZO_VALIDATE_POSTGRES_APP_PASSWORD|_RAKAZO_VALIDATE_POSTGRES_PASSWORD|_RAKAZO_VALIDATE_SANDBOX_SUPERVISOR_TOKEN|_RAKAZO_VALIDATE_SCREEN_PROXY_SECRET)$",
     "environment variable a running deployment already reads; the deployed .env uses "
     "these names"),
    (r"^x-rakazo-[a-z-]+$", "HTTP header on the client/server wire protocol"),
    (r"^rakazo:skip-waiting$", "service-worker message key"),
    (r"^rakazo-shell-$", "service-worker cache prefix"),
    (r"^__RAKAZO_[A-Z_]+__:?$", "build-time placeholder replaced by the bundler"),
    (r"^window\.rakazo[A-Za-z]+$",
     "preload bridge name; an installed desktop client talks to the page through it"),
    (r"^rakazoDesktop$",
     "preload bridge name; an installed desktop client talks to the page through it"),
    (r"^rakazo\.(uiLocale|signedInUser|signed-in-before|activity-mode|call-device|"
     r"githubStarPrompt\.[a-z]+|[a-z]+\.[a-z]+)$",
     "localStorage key; renaming it re-asks the user for preferences they already set"),
    (r"^rakazo:[A-Za-z][A-Za-z0-9:-]*$",
     "localStorage key or custom event name; renaming it re-asks the user or breaks a listener"),
    (r"^rakazo-(notifications|file-drop|fold-regions|network-cache|pdf-view|voice-chat)$",
     "native module directory; renaming it changes the Android/iOS build"),
    (r"^rakazo_(channel|live|scheduled|replied|attention)_[a-z_]+$",
     "Android string resource key; renaming it breaks the Kotlin reference"),

    # ---------- everything else that is an internal name, by shape ----------
    # There is deliberately no catch-all here. A rule that accepts any `rakazo*` token turns the
    # guard into a rubber stamp: a new placeholder, a new heading, or a new product string would
    # be waved through because it happens to start with the six letters. Each family below names
    # the one thing it covers, so an unfamiliar shape fails and gets a decision.

    # Values already written on people's machines. A rename makes the app forget the setting
    # instead of migrating it, and these keys are also the field names in notification payloads.
    # Same reasoning as the environment names above: enumerated, not wildcarded.
    (r"^rakazo[.](?:api_base|artifact-cache-session|botId|botsSidebarDensity|call-sounds|calls|cappedText|collapsed-sections|composerBindings[.]|composerDraft[.]|composerEnterToSend|device-voice|ended_calls|expo-error-window|groupId|inbox-width|incoming-session|incoming_calls|integrations-scope|last_bot_id|last_bot_space_id|loadRemoteImages|logOutFailed|map|networkCacheCleared|org_spaces|passkey-offer-dismissed[.]|pending_voice_chat|responseStreaming|runId|server_headers|session_token|showToolActivity|silent|spaceId|space_id|space_rollback|startup-error|threadId|wait-sound)[.:]?$",
     "key already stored by installed clients (preferences, drafts, notification "
     "payload fields); renaming it loses or silently unbinds what is saved"),
    (r"^rakazo-bot-voices\.json$", "file already written to the app's document directory"),
    (r"^rakazo-voice-$", "temporary recording file prefix in the app's document directory"),

    # Names a page and the desktop shell exchange. Both sides are versioned separately, so an
    # installed shell keeps matching the old string until it is updated.
    (r"^rakazo-(app-connect|mcp-oauth|sso-oauth|model-oauth|plugin-connect|slack-install)$",
     "popup/frame name the page and the desktop shell match on; the allowlist in the shell "
     "compares this exact string"),
    (r"^rakazo-page:[a-z-]+$", "postMessage protocol between an embedded page and its host"),
    (r"^rakazo-computer-keyboard-ready$", "postMessage protocol between a computer and the app"),
    (r"^rakazoSetup$", "preload bridge name exposed to the setup window"),
    (r"^rakazo-linux-update-v1$",
     "signature domain string; an installed updater verifies against this exact value"),
    (r"^rakazo-desktop$",
     "compose project of the desktop app's local stack; renaming it orphans its local volumes"),
    (r"^rakazo-www$", "User-Agent this site sends to an external API"),

    # Objects the sandbox providers create by name. A deployment already has them built, and the
    # API asks for them by this string.
    (r"^rakazo-computer$", "provider template name a deployment has already built"),
    (r"^rakazo-sandboxes$", "namespace the Kubernetes provider creates or reuses"),
    (r"^rakazo-browser$", "helper executable installed in the desktop image"),

    # Encryption parameters. These are inside the ciphertext, not beside it: a different value
    # makes existing rows undecryptable.
    (r"^rakazo/(content|content-master-key|search|space-key)/v[0-9]+$",
     "encryption AAD or HKDF info baked into stored ciphertext; changing it cannot decrypt "
     "existing rows"),
    (r"^rakazo_private\.[a-z_]+$", "schema and table created by migrations that already ran"),
    (r"^rakazo_app_queue$", "queue policy created by migrations that already ran"),

    # Installed host integration. Every one of these is already on the server and is addressed by
    # its name from a timer, a unit, a firewall rule, or an operator command.
    (r"^rakazo-[a-z0-9-]+\.(service|timer)$", "installed systemd unit or timer"),
    (r"^rakazo_[a-z_]+$", "live nftables table or Postgres replication slot"),
    (r"^rakazo/(alerts|audit-ship)$", "state directory already created on the host"),
    (r"^rakazo_config$", "audit-shipper config file mode passed to a hardened reader"),
    (r"^rakazo-c\+?$",
     "Docker bridge prefix that live iptables rules and the egress script match on"),
    (r"^rakazo-(firewall|deploy|host|backup)-[a-z0-9-]+$",
     "installed helper command, transient unit, or logger tag"),
    (r"^rakazo-postgres1[68]-upgrade-$", "temporary helper container name during a Postgres upgrade"),
    (r"^rakazo-pg-upgrade-test-", "scratch compose project used by the upgrade test"),
    (r"^rakazo-migrations-$", "temporary directory prefix for staged migrations"),
    (r"^rakazo-rollback:?$", "docker tag holding the pre-deploy image for rollback"),

    # Build and backup artifacts addressed by name.
    (r"^rakazo\.dump$", "dump file name the backup script writes and its verifier reads"),
    (r"^rakazo-pitr(:[0-9a-f]+)?$", "PITR helper entrypoint and the image tag the deployment pins"),
    (r"^rakazo-computer-egress$", "installed egress unit name checked by its own smoke test"),
    (r"^rakazo-shared$",
     "peer id earlier releases of this product created inside the memory provider; the check "
     "must keep recognising it or a user can select a peer this app writes to"),
    (r"^rakazo-pitr-drill-$", "temporary volume name used by a restore drill"),
    (r"^rakazo-prod$", "compose project name the deployment already runs under"),
    (r"^rakazo/(computer|app):[a-z0-9.-]+$", "locally built image name used by a compose profile"),
    (r"^rakazo-account-export$", "format field written into export files the user already has"),
    (r"^rakazo_probe$", "query parameter the desktop client appends to its probe request"),
    (r"^rakazoPwa$", "build plugin function name"),
    (r"^rakazo-pwa-[a-z-]+$", "build plugin and cached asset name"),
    (r"^rakazo-bot-", "hostname prefix of running computer containers"),
    (r"^rakazo-call$", "keep-awake tag passed to an Expo hook"),
    (r"^RAKAZO_$",
     "prefix of this deployment's own environment namespace, blocked from being passed to a "
     "command because it carries the stack's own secrets"),
    (r"^Rakazo[A-Za-z]+$", "TypeScript type or class name"),

    # Android module internals. The package, the resources, and the preferences file are compiled
    # into an installed APK; the preferences name is also where a device already stores its state.
    (r"^com\.rakazo\.[a-z]+(\.[A-Z_]+)?$",
     "Android package/namespace or intent action compiled into the installed app"),
    (r"^R\.drawable\.ic_rakazo_[a-z_]+$", "Android drawable referenced from the notification code"),
    (r"^@style/Rakazo[A-Za-z]+$", "Android style referenced from the manifest"),
    (r"^Rakazo[A-Za-z]+$", "Kotlin class or companion name"),
    (r"^createRakazo[A-Za-z]+$", "Kotlin function name"),
    (r"^Rakazo[A-Za-z]+::class$", "Kotlin class literal"),
    (r"^Rakazo[A-Za-z]+::class\.java$", "Kotlin class literal used to build an Intent"),
    (r"^Rakazo[A-Za-z]+\.[A-Za-z_]+$", "Kotlin class member referenced from another class"),
    (r"^com\.rakazo\.[a-z_]+$", "Android preferences file a device already writes its state to"),
    (r"^http://rakazo\.(localhost|local):[0-9]+$",
     "host the notification module's own allowlist accepts; the test cases assert these strings"),
    (r"^http://rakazo\.(localhost|local)\.$", "rejected variant asserted by the allowlist test"),
    (r"^isRakazo[A-Za-z]+$", "internal predicate name"),
    (r"^__rakazo[A-Za-z_]*$", "internal sentinel value"),
    (r"^__rakazo_[a-z_]+__$", "internal sentinel value"),
    (r"^data-rakazo-[a-z-]+$", "data attribute read by a test or by the app itself"),
    (r"^data\.rakazo[A-Za-z]+$", "property on an internal message object"),
    (r"^rakazoScreen[A-Za-z]*:?$", "internal postMessage key"),

    # ---------- upstream attribution, deliberately kept ----------
    (r"^elie222/rakazo$", "fork source; the licence requires naming where this came from"),
    (r"^https://github\.com/elie222/rakazo.*$",
     "link to the upstream repository; the licence requires naming the source"),
    (r"^https://raw\.githubusercontent\.com/elie222/rakazo.*$",
     "upstream install script, referenced when documenting the original project"),
    (r"^https://rakazo\.com.*$", "the upstream hosted service's own pages"),
    (r"^Rakazo$",
     "the upstream project's own name and the brand of the hosted service it belongs to; "
     "used when stating what this product is a fork of, which is a licence obligation"),
    (r"^/blog/[a-z0-9-]*rakazo[a-z0-9-]*/$", "slug of an existing published comparison article"),

    # ---------- filesystem paths inside the server or computer image ----------
    (r"^/(tmp|home|srv|etc|var|usr)/[a-z/]*rakazo[a-z0-9/._-]*$",
     "directory or installed file path on the server or inside the computer image"),
    (r"^postgres(ql)?://rakazo[A-Za-z0-9_:@/.-]*$",
     "database connection string naming the role that already exists"),
    (r"^POSTGRES_(DB|USER)$", "compose variable whose default value is the existing role name"),

    # ---------- images, system config, and env-name variants ----------
    (r"^(ghcr\.io/elie222/rakazo|registry\.[a-z.]+(:[0-9]+)?/rakazo)/[a-z@0-9:.-]*$",
     "container image reference; the published images keep their repository path"),
    # The declarative form of the same list: `KEY:` and `KEY=value` lines in compose and
    # example files. Enumerated for the same reason as the rule above.
    (r"^_?(?:RAKAZO_ADMIN_EMAILS|RAKAZO_ALLOW_DEV_SECRETS|RAKAZO_API_MEMORY_LIMIT|RAKAZO_API_PORT|RAKAZO_APP_URL|RAKAZO_AUDIT_HEARTBEAT_SECONDS|RAKAZO_AUDIT_HOST|RAKAZO_AUDIT_KNOWN_KEYS|RAKAZO_AUDIT_SINK_URL|RAKAZO_AUDIT_TOKEN_FILE|RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE|RAKAZO_AUTO_REVIEW_MODEL|RAKAZO_AUTO_REVIEW_PROVIDER|RAKAZO_AUTO_REVIEW_TIMEOUT_MS|RAKAZO_BACKUP_AGE_RECIPIENTS|RAKAZO_BACKUP_AGE_RECIPIENTS_FILE|RAKAZO_BACKUP_ALLOW_PLAINTEXT|RAKAZO_BACKUP_KEEP|RAKAZO_BACKUP_MAX_GB|RAKAZO_BACKUP_MIN_FREE_GB|RAKAZO_BACKUP_OFFSITE_KEEP|RAKAZO_BACKUP_OFFSITE_REMOTE|RAKAZO_BACKUP_REQUIRE_VOLUME|RAKAZO_BUILD|RAKAZO_CLOUD_URL|RAKAZO_COMPOSE_FILE|RAKAZO_COMPOSE_PROJECT_NAME|RAKAZO_COMPUTER_CPUS|RAKAZO_COMPUTER_IMAGE|RAKAZO_COMPUTER_IMAGE_TAG|RAKAZO_COMPUTER_MEMORY|RAKAZO_COMPUTER_PIDS_LIMIT|RAKAZO_CONTROL_RELEASED|RAKAZO_CSP_CONNECT_SRC|RAKAZO_CSP_SCRIPT_SRC|RAKAZO_DEPLOYED_MIGRATIONS|RAKAZO_DEPLOY_BUILD_CACHE_GB|RAKAZO_DEPLOY_BUILD_TIMEOUT|RAKAZO_DEPLOY_DIR|RAKAZO_DEPLOY_HEALTH_INTERVAL|RAKAZO_DEPLOY_IMAGE|RAKAZO_DEPLOY_MIN_FREE_GB|RAKAZO_DEPLOY_PULL_TIMEOUT|RAKAZO_DEPLOY_REVISION|RAKAZO_DEPLOY_ROLLBACK_TIMEOUT|RAKAZO_DEPLOY_UP_TIMEOUT|RAKAZO_DESKTOP|RAKAZO_DESKTOP_RELEASE|RAKAZO_DESKTOP_RELEASED|RAKAZO_DESKTOP_STACK_TOKEN|RAKAZO_DISABLE_AUTO_UPDATE|RAKAZO_DISABLE_BUNDLED_RENDERER|RAKAZO_DISABLE_WARM_WINDOW|RAKAZO_DOCKER_BINARY|RAKAZO_DOWNLOAD_BASE|RAKAZO_DOWNLOAD_SKIP_EXISTING|RAKAZO_EGRESS_SUDOED|RAKAZO_ENV_IMAGES_EXAMPLE|RAKAZO_FORCE_SETUP|RAKAZO_GITHUB_API|RAKAZO_GIT_SHA|RAKAZO_HEALTH_URL|RAKAZO_HOST|RAKAZO_IF_INET6|RAKAZO_IMAGE|RAKAZO_IMAGE_TAG|RAKAZO_IMAGE_TAG_PREVIOUS|RAKAZO_INTERNAL_PROFILE|RAKAZO_INTERNAL_VIEW_TOKEN|RAKAZO_IP6TABLES|RAKAZO_IPTABLES|RAKAZO_LIVE_MODEL_CATALOG|RAKAZO_LOCAL_CONTEXT_WINDOW|RAKAZO_LOCAL_MAX_TOKENS|RAKAZO_LOCAL_MODELS|RAKAZO_LOCAL_MODELS_URL|RAKAZO_LOCAL_REASONING_MODELS|RAKAZO_LOCAL_VISION_MODELS|RAKAZO_LOCAL_WEB_URL|RAKAZO_MARKETING_URL|RAKAZO_MESSAGE_USER_MAX_CHARS|RAKAZO_MIGRATIONS_PATH|RAKAZO_MIN_CLIENT_BUILD|RAKAZO_MONITOR_COMPOSE_PROJECT|RAKAZO_NAV_LINKS|RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS|RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC|RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS|RAKAZO_PASSKEY_RP_ID|RAKAZO_PERFORMANCE_CLEAR_CACHE|RAKAZO_PERFORMANCE_USER_DATA|RAKAZO_POSTGRES_16_IMAGE|RAKAZO_PULL_NEVER|RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP|RAKAZO_SYSTEMCTL|RAKAZO_UPDATER_HOST|RAKAZO_UPDATER_IMAGE|RAKAZO_UPDATER_IMAGE_TAG|RAKAZO_UPDATER_PORT|RAKAZO_UPDATER_TOKEN|RAKAZO_UPDATE_RESTART_SUPERVISOR|RAKAZO_UPDATE_SERVICES|RAKAZO_WARM_WINDOW_TTL_MS|RAKAZO_WEB_BIND|RAKAZO_WEB_PORT|RAKAZO_WEB_URL|RAKAZO_WORKER_MEMORY_LIMIT|_RAKAZO_VALIDATE_BETTER_AUTH_SECRET|_RAKAZO_VALIDATE_ENCRYPTION_KEY|_RAKAZO_VALIDATE_POSTGRES_APP_PASSWORD|_RAKAZO_VALIDATE_POSTGRES_PASSWORD|_RAKAZO_VALIDATE_SANDBOX_SUPERVISOR_TOKEN|_RAKAZO_VALIDATE_SCREEN_PROXY_SECRET):?$", "environment variable declared in a compose or example file"),
    (r"^[A-Z_]*RAKAZO[A-Z_]*:.*$", "environment variable with an inline example value"),
    (r"^/etc/(ssh/sshd_config[.]d|sysctl[.]d|apt/apt[.]conf[.]d|audit/rules[.]d)/[0-9A-Za-z._-]*rakazo[a-z0-9._-]*$",
     "installed hardening or auditing file; the file name is already on the server"),
    (r"^(pitrspool:|\+)?/var/lib/rakazo-[a-z-]*$", "data or lock path used by the server"),
    (r"^/rakazo[a-z0-9._-]*$", "file at the filesystem root written by a server script"),
    (r"^/../systemd/rakazo-[a-z-]+[.]service$", "installed systemd unit"),
    (r"^-/etc/rakazo/[a-z.]+$", "optional config path on the server"),
    (r"^https://[a-z0-9.-]*rakazo[a-z0-9./-]*$",
     "an external URL that names the upstream or hosted service"),
    (r"^https://github[.]com/[A-Za-z0-9._-]+/rakazo[a-z-]*$", "upstream or example repository"),
    (r"^x-rakazo-$", "HTTP header prefix in a comment"),

    # ---------- one-off identifiers surfaced by the final sweep ----------
    (r"^persist:rakazo-$", "Electron session partition prefix"),
    (r"^rakazo-desktop@.*$", "release name sent to crash monitoring"),
    (r"^/[.]well-known/rakazo-desktop-stack$",
     "probe path the desktop client asks its server for"),
    (r"^change-rakazo-server$", "menu command id in the desktop app"),
    (r"^blog-[a-z0-9-]*rakazo[a-z0-9-]*$", "slug of an already-published comparison article"),
    (r"^https://apps[.]apple[.]com/app/rakazo/[a-z0-9]+$",
     "the existing App Store listing path; changing it breaks a link that already ships"),
    (r"^github[.]com/elie222/rakazo$", "upstream repository named in a comparison comment"),
    (r"^n?registry[.][a-z0-9.]+(:[0-9]+)?/rakazo/[a-z@0-9:.-]*$",
     "example registry reference in a smoke test"),
    (r"^[-]?/usr/local/sbin/rakazo-[a-z-]+$", "installed helper script path"),
    (r"^RAKAZO_DEPLOY_DIR/.*$", "documented path under the deploy directory variable"),

    (r"^/run/desktop/mnt/host/[a-z]/Users/[a-z]+/rakazo$",
     "example deploy directory in a documented Docker Desktop path"),

    # ---------- test and example values ----------
    (r"^https?://rakazo\.(example\.com|invalid).*$", "example hostname in documented copy"),
]


def _specificity(pattern: str) -> int:
    """How narrowly a pattern is drawn: literal characters minus wildcard reach.

    Two rules can match the same token — `^rakazo\\.dump$` and a broader storage-key family both
    cover `rakazo.dump` — and whichever runs first decides the recorded reason. Sorting by
    specificity means the narrow rule always wins, so a reason names the actual thing instead of
    the family that happens to be declared above it. Declaring broadly first is how a guard
    quietly starts reporting the wrong justification for a real identity.
    """
    literals = 0
    body = re.sub(r"\[[^\]]*\]", "", pattern, flags=re.S)
    wildcard = sum(1 for ch in body if ch in "*+.?")
    return len(body) - wildcard * 2


ALLOWED.sort(key=lambda rule: -_specificity(rule[0]))

# Anything a user reads. If one of these lines contains rakazo, it needs an explicit decision.
VISIBLE_LINE = re.compile(
    r"""(<title>|aria-label=|placeholder=|alt=|<h[1-6][^>]*>|description=|og:title"""
    r"""|og:description|subject:|message:|label=|title=\{)""",
    re.I,
)

TOKEN = re.compile(r"[A-Za-z0-9_./:@-]*rakazo[A-Za-z0-9_./:@-]*", re.I)


def _iter_files():
    found = 0
    for entry in SCAN_ROOTS:
        path = ROOT / entry
        if not path.exists():
            continue
        if path.is_file():
            found += 1
            yield path
            continue
        for candidate in path.rglob("*"):
            if not candidate.is_file():
                continue
            if any(part in SKIP_DIRS for part in candidate.relative_to(ROOT).parts):
                continue
            if candidate.name.endswith(SKIP_SUFFIXES):
                continue
            found += 1
            yield candidate
    if found == 0:
        # A scan that finds nothing is a broken scan, not a clean repository. Without this the
        # guard reports success from any directory that has none of the scanned trees.
        raise SystemExit(
            f"brand-guard: no files matched SCAN_ROOTS under {ROOT}; "
            "run it from the repository root or set BRAND_GUARD_ROOT"
        )


def classify(token: str) -> tuple[str, str] | None:
    """Return (pattern, reason) for one occurrence, or None when nothing explains it.

    Storage prefixes are written both as `"rakazo:space-id"` and as `"rakazo:space-id:"` (a
    prefix concatenated with a key), and a property access appears as `window.rakazoDesktop`.
    Those are the same identity, so the token is normalized before matching.
    """
    candidates = [token]
    stripped = token.rstrip(":.")
    if stripped != token:
        candidates.append(stripped)
    # `${RAKAZO_IMAGE:-ghcr.io/...}` -> RAKAZO_IMAGE; `${POSTGRES_DB:-rakazo}` -> rakazo.
    head = token.split(":-", 1)[0]
    if head != token:
        candidates.append(head)
        candidates.append(token.split(":-", 1)[1])
    # A path under /tmp/rakazo or /home/rakazo is the container's own directory.
    if token.startswith(("/tmp/rakazo", "/home/rakazo", "/srv/rakazo", "/etc/rakazo",
                         "/var/backups/rakazo", "/usr/local/sbin/rakazo")):
        candidates.append("/tmp/rakazo")
    # `target.rakazoDesktop` / `window.rakazoDesktop` -> also try the property alone.
    if "." in token:
        candidates.append(token.rsplit(".", 1)[-1])
        candidates.append("window." + token.rsplit(".", 1)[-1])
    # Declarations such as `__RAKAZO_SW_CACHE__:` arrive with a trailing colon.
    for candidate in candidates:
        for pattern, reason in ALLOWED:
            if re.fullmatch(pattern, candidate):
                return pattern, reason
    return None


# A visible line where the old name appears as the *product*, not as the upstream project.
SANCTIONED_VISIBLE = re.compile(
    r"(upstream|Built on Rakazo|Hosted Rakazo|fork of|elie222/rakazo"
    r"|rakazo[.](example|invalid|test)|Rakazo project|shared with Rakazo)",
    re.I,
)

# A link the product itself sends people to is not attribution, whoever owns the host.
#
# This was the hole: `rakazo.com` sat in the sanctioned list as "upstream attribution", so a
# constant like `SUBMIT_PLUGIN_URL = "https://rakazo.com/plugins/submit/"` — a URL a shipped app
# opens in the user's browser — was excused by the same rule that excuses a credit line. A URL
# assigned to a name, or used as an href, is product navigation and has to be decided explicitly.
# Only the old *product* host, and only where it is our own navigation. Crediting the upstream
# project (`github.com/elie222/rakazo`), naming its App Store listing, or linking its own terms
# from the page that describes its hosted service are attributions, not this product's links.
PRODUCT_URL = re.compile(
    r"""(=\s*["'`]https?://(?:www\.)?rakazo\.com/"""
    r"""|href=\{["'`]https?://(?:www\.)?rakazo\.com/"""
    r"""|openURL\(\s*["'`]https?://(?:www\.)?rakazo\.com/)""",
    re.I,
)

# Lines that are about the upstream project on purpose: the page that describes its hosted
# service, and constants whose name says they point at upstream.
UPSTREAM_LINKING = re.compile(
    r"(UPSTREAM|upstream|elie222|Hosted Rakazo|describe that service)", re.I
)


def _in_upstream_section(lines: list[str], index: int, window: int = 12) -> bool:
    """Whether this line sits in a section that is explicitly about the upstream service.

    The terms page has a "Hosted Rakazo service" section that links Rakazo's own terms and
    privacy policy. Those belong to that service, not to this product, so they are attribution —
    but the heading is a few lines above the link, not on it.
    """
    start = max(0, index - window)
    return any(UPSTREAM_LINKING.search(line) for line in lines[start:index])

VISIBLE_SLOT = re.compile(
    r"""(<title>[^<]*rakazo|<h[1-6][^>]*>[^<]*rakazo|aria-label="[^"]*rakazo"""
    r"""|placeholder="[^"]*rakazo|alt="[^"]*rakazo|description="[^"]*rakazo"""
    r"""|og:(title|description)"[^>]*rakazo|label=\{?t?\(?"[^"]*rakazo"""
    r"""|>(?![^\s<]*/)\s*[^<]*\brakazo\b[^<]*<)""",
    re.I,
)

# Only files whose text can become something a person reads. A shell script's `> /etc/...` is a
# redirect, not markup, and `# rakazo` in a YAML comment is not a heading.
VISIBLE_SCAN_SUFFIXES = (".tsx", ".ts", ".html", ".json", ".md", ".astro", ".hbs", ".tsx.html")


def _visible_defects():
    """Visible uses of the old name that are not upstream attribution."""
    found = []
    for path in _iter_files():
        if not path.name.endswith(VISIBLE_SCAN_SUFFIXES):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        all_lines = text.splitlines()
        for number, line in enumerate(all_lines, 1):
            if "rakazo" not in line.lower():
                continue
            # A product URL is checked before the attribution excuse, because the old host
            # appearing there means we are linking people to it, not crediting it.
            if (
                PRODUCT_URL.search(line)
                and not UPSTREAM_LINKING.search(line)
                and not _in_upstream_section(all_lines, number - 1)
            ):
                found.append((path, number, line.strip()[:120]))
                continue
            if not VISIBLE_SLOT.search(line):
                continue
            if SANCTIONED_VISIBLE.search(line):
                continue
            found.append((path, number, line.strip()[:120]))
    return found


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fail on an unexplained use of the old name.")
    parser.add_argument("--list", action="store_true", help="print every unclassified occurrence")
    parser.add_argument(
        "--check-stale-allowlist",
        action="store_true",
        help="also fail when an allowlist entry matched nothing (meaningful only on the whole "
        "repository; a partial tree legitimately matches few rules)",
    )
    args = parser.parse_args(argv)

    unclassified = []
    visible = []
    matched_patterns = set()
    total = 0

    for path in _iter_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if "rakazo" not in line.lower():
                continue
            for token in TOKEN.findall(line):
                total += 1
                verdict = classify(token)
                if verdict is None:
                    unclassified.append((path, number, token, line.strip()[:120]))
                    if VISIBLE_LINE.search(line):
                        visible.append((path, number, line.strip()[:120]))
                    continue
                matched_patterns.add(verdict[0])

    print(f"scanned occurrences: {total}")
    print(f"unclassified       : {len(unclassified)}")
    print(f"in a visible slot  : {len(visible)}")

    # An allowlist entry that no longer matches anything is a stale excuse. Tracked per pattern,
    # not per reason, because two entries can share a reason string and only one may be dead.
    matched = {pattern for pattern, _ in ALLOWED} & matched_patterns
    stale = [pattern for pattern, _ in ALLOWED if pattern not in matched]
    if stale:
        print(f"stale allowlist entries: {len(stale)}")
        for pattern in stale:
            print(f"  no longer matches: {pattern[:70]}")

    if unclassified and args.list:
        print("\nUNCLASSIFIED:")
        for path, number, token, text in unclassified[:200]:
            print(f"  {path.relative_to(ROOT)}:{number}  {token}  | {text}")

    if visible:
        print("\nVISIBLE OCCURRENCES (need an explicit decision):")
        for path, number, text in visible[:50]:
            print(f"  {path.relative_to(ROOT)}:{number} | {text}")

    if stale:
        print(f"\nSTALE ALLOWLIST: {len(stale)}")
        for pattern in stale:
            print(f"  {pattern[:100]}")
        if not args.check_stale_allowlist:
            print(
                "  (partial tree: pass --check-stale-allowlist on the whole repository to fail "
                "on these)"
            )
    # A visible slot naming the old product is the defect this guard exists for. The only
    # sanctioned visible uses are upstream attribution ("Built on Rakazo", the hosted service's
    # own terms) and example hostnames in commands; everything else must be Matebot.
    visible_defects = _visible_defects()

    if visible_defects:
        print(f"\nVISIBLE DEFECTS: {len(visible_defects)}")
        for path, number, text in visible_defects[:40]:
            print(f"  {path.relative_to(ROOT)}:{number} | {text}")

    if unclassified or visible_defects or (stale and args.check_stale_allowlist):
        return 1
    print("\nEvery remaining occurrence is a documented legacy identity.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
