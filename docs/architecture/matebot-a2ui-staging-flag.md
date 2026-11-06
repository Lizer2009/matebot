# Enabling the `a2ui` feature flag (staging)

Default is **off** (Matebot 0.6.0 behavior). Do not enable on production until the Email MVP E2E is green and maintainers agree.

## Staging host `192.168.10.5` (env/config only)

This document is enablement and image-pull guidance only. **Do not** push Docker images or deploy from an unattended agent to that host. Do not overwrite production `edge` unless maintainers intend a mainline roll.

### API / Worker

Set on the API (and Worker if it ever reads the same gate) process environment:

```bash
FEATURE_A2UI=1
```

Accepted values: `1`, `true`, `on` (case-insensitive). Omit or set `0`/`false`/`off` to keep A2UI RPC gated.

Restart the API container/process after changing env. No `RAKAZO_*` renames.

### Web (Vite)

Build or runtime for the web UI:

```bash
VITE_FEATURE_A2UI=1
```

Or, for a single browser session without rebuild:

```js
localStorage.setItem("matebot.feature.a2ui", "1");
location.reload();
```

Storage key: `matebot.feature.a2ui`. Env wins over storage when set.

### Mobile (Expo)

Set before starting the Expo bundle (then restart Expo):

```bash
EXPO_PUBLIC_FEATURE_A2UI=1
```

Accepted values match the API gate (`1` / `true` / `on`). Unset keeps mobile surfaces hidden.

### Database

Apply the additive `interactions` / `interaction_surfaces` migration with the normal migrate path before exercising persisted surfaces. Older API releases ignore these tables.

### App image for this tip (prefer `sha-` only)

`publish-server-image` tags `edge` **only** when `github.ref == refs/heads/main`. Dispatching the workflow on the A2UI tip branch therefore publishes **`sha-<full-commit>`** without moving `edge`.

1. Ensure the tip includes the Dockerfile `packages/a2ui-adapter/package.json` COPY (cold `pnpm install --frozen-lockfile` otherwise fails).
2. From a maintainer machine with write access to Actions:

```bash
TIP_REF=cursor/a2ui-pr10-mobile-catalog-1fe7
gh workflow run publish-server-image.yml --repo Lizer2009/matebot --ref "$TIP_REF"
gh run list --repo Lizer2009/matebot --workflow publish-server-image.yml --limit 3
# after success:
git fetch origin "$TIP_REF"
TIP_SHA=$(git rev-parse "origin/$TIP_REF")
echo "Pull: ghcr.io/lizer2009/matebot/app:sha-${TIP_SHA}"
```

3. On `192.168.10.5`, point Compose at the published tip tag (example; do not SSH from this agent):

```bash
# After a successful publish-server-image workflow_dispatch on tip
# cursor/a2ui-pr10-mobile-catalog-1fe7 (Cloud Agents get Actions 403 on dispatch —
# a maintainer must Run workflow on that ref):
TIP_REF=cursor/a2ui-pr10-mobile-catalog-1fe7
git fetch origin "$TIP_REF"
TIP_SHA=$(git rev-parse "origin/$TIP_REF")
export RAKAZO_IMAGE=ghcr.io/lizer2009/matebot/app:sha-${TIP_SHA}
# then restart the stack with the normal compose path for that host
```

Exact pull tag = `ghcr.io/lizer2009/matebot/app:sha-<full-40-char-sha-of-the-dispatched-tip-commit>`. `edge` is **not** moved (publish-image only enables `edge` when `github.ref == refs/heads/main`). There is no separate `a2ui` moving tag today. Do **not** dispatch with `--ref main` for this experiment if the goal is to avoid touching `edge`.

### Agent email compose (when flag on)

With `FEATURE_A2UI` enabled on the API/worker, the built-in `present_interaction` tool is offered to interactive runs. A natural-language request to compose or send mail (any language) should call that tool with an `email.compose` `InteractionPlan`, which publishes an `a2ui_surface` via `publishInteractionSurface`. Flag off: the tool is not offered; legacy `request_secret` / ask / ExternalEffect paths stay unchanged (including SMTP auth when a secret is missing).

### Verify flag-off

With flags unset/off: no A2UI surfaces in the timeline, `present_interaction` is not offered to the agent, `threads.getA2uiSurface` / interaction RPCs return not-found / unavailable, and existing ask / ExternalEffect flows unchanged.
