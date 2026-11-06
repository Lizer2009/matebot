# Enabling the `a2ui` feature flag (staging)

Default is **off** (Matebot 0.6.0 behavior). Do not enable on production until the Email MVP E2E is green and maintainers agree.

## Staging host `192.168.10.5` (env/config only)

This document is enablement guidance only. **Do not** push Docker images or deploy from this PR chain.

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

### Database

Apply the additive `interactions` / `interaction_surfaces` migration with the normal migrate path before exercising persisted surfaces. Older API releases ignore these tables.

### Verify flag-off

With both flags unset/off: no A2UI surfaces in the timeline, `threads.getA2uiSurface` / interaction RPCs return not-found / unavailable, and existing ask / ExternalEffect flows unchanged.
