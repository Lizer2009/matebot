# A2UI Surface host (PR-3)

Web timeline host for `MessageBlock.kind === "a2ui_surface"`. Uses npm `@a2ui/react@0.15.0` + `@a2ui/web_core@0.15.0` (design §4.3 **B**, same line as `@matebot/a2ui-adapter`; upstream pin SHA documented there).

## Feature flag (`a2ui`)

**Default: off** — production MessageView ignores `a2ui_surface` blocks (0.6.0 behavior).

Enable locally:

1. `VITE_FEATURE_A2UI=1 pnpm --filter @matebot/web dev`, or
2. `localStorage.setItem("matebot.feature.a2ui", "1")` then reload.

## Fixture

```bash
pnpm --filter @matebot/web dev
# open /e2e/fixtures/a2ui-surface.html
# ?refuse=1 — unknown-component refuse path
# ?flag=off — proves MessageView hides surfaces when disabled
```

## Boundaries

- page-kit (`kind: page`) stays a sibling — not merged.
- Unknown catalog components are refused before `@a2ui/react` mounts.
- `@a2ui/*` loads via dynamic `import()` inside the host when the flag is on.
- Electron reuses `web/dist` — no second host.
- Next: PR-4 Interaction/Surface persistence.
