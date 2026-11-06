# `@matebot/a2ui-adapter`

Thin A2UI protocol adapter for Matebot (design PR-2).

Business code depends on Matebot `InteractionPlan` and this package’s API — not scattered `@a2ui/*` literals.

## Upstream pin

| Field | Value |
| --- | --- |
| Fork | [`Lizer2009/a2ui`](https://github.com/Lizer2009/a2ui) |
| **Commit (full SHA)** | `dee8167996b0a802b18b3ebe51f3515c55b757de` |
| Render family (Phase 1) | **v0.9** |
| Server | **v0.9 + reserved v1.0** (dual-track) |
| Package path | `typescript/core/web_core` → `@a2ui/web_core` |

Constant: `A2UI_UPSTREAM_COMMIT` / `A2UI_PNPM_GIT_SPEC` in `src/pin.ts`.

## Install strategy (design §4.3 **A**)

```text
github:Lizer2009/a2ui#dee8167996b0a802b18b3ebe51f3515c55b757de&path:typescript/core/web_core
```

- Pin is the **full commit SHA** (not floating `main`).
- Matebot stays on **pnpm**; do not merge the a2ui yarn workspace into this repo.
- Upstream’s git `prepare`/`prepack` builds `@a2ui/web_core` from that commit (yarn inside the fetched package only).
- Package version at the pin is `0.15.0` (npm package version ≠ protocol version).

## Dual-track

| Track | `@a2ui/web_core` export | Default for compile |
| --- | --- | --- |
| Active | `./v0_9` | yes |
| Reserved | `./v1_0` | no (schema path + enum only until React hosts it) |

Protocol family values reuse `@matebot/contracts` `A2uiProtocolFamily` (`v0_9` \| `v1_0`).

## Optional load boundary

`@a2ui/web_core` is loaded via `dynamic import()` inside this package. Apps that never depend on `@matebot/a2ui-adapter` are unaffected. Product wiring and the `a2ui` feature flag stay off until later PRs.

## Commands

```bash
pnpm --filter @matebot/a2ui-adapter check
pnpm --filter @matebot/a2ui-adapter test
```

## Fixtures

Minimal offline JSON under `fixtures/` — schema conformance tests do not need the network after dependencies are installed.
