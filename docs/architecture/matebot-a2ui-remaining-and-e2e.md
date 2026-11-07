# A2UI remaining work and end-to-end evidence

Covers the work between PR #39 and this PR, plus the actual end-to-end run.
The approved spec ([`matebot-a2ui-best-practices-v1.1.md`](./matebot-a2ui-best-practices-v1.1.md))
remains authoritative; Phase 0's live-model gate and Phase 1's provider gap are
still open and are **not** cleared here.

Base: PR #39 tip `c4b4a953`.

---

## What this change adds

| Item | State | Evidence |
|---|---|---|
| Re-query reads a **registered** source, never a model-named endpoint | **Done** | `packages/core/src/result-source.ts`; 9 tests; sim rows |
| A source declares its own connection requirement | **Done** | `requiresConnection` on each entry; a source needing one refuses without a bound connection |
| `refresh_result` is a production tool | **Done** | Declared in `builtin-tools.ts`, dispatched by `applyTool`; 6 tests including the loop |
| A refresh actually re-reads (not relabelled rows) | **Done** | The test source returns rows derived from the requested window; a relabel would fail |
| Same-card update with a new revision | **Done** | `republishResultSurface`: one interaction, revision +1, surface and block rewritten, SSE emitted |
| Stale refresh and ambiguous multi-card refused | **Done** | `stale_revision`; `ambiguous_target` with candidates |
| Scripted runtime can drive the real A2UI tools | **Done** | `inferScript` handles `call <tool> with {…}` for the four tools |
| End-to-end launcher without Docker | **Done** | `apps/api/e2e-a2ui.mjs` |

## The end-to-end run (real, not a fixture page)

A real Chromium browser against the real web app, the real oRPC router, the real
executor, and a disposable migrated PostgreSQL 18.6 — with the SSE stream the
cards listen to. This is not `a2ui-email.spec.ts`, which loads a static HTML
fixture.

| Item | Value |
|---|---|
| Browser | Chromium 156.0.8078.4 (Playwright 1.64.1, headless) |
| Database | PostgreSQL 18.6, user-space `embedded-postgres`, `/tmp/e2e-pg` |
| Migrations | the full migration set, applied with `prisma migrate deploy` |
| Roles | owner `matebot` (migrations), runtime `matebot_app` (non-superuser, so RLS is enforced) |
| API | real `createApp` on `127.0.0.1:3110` |
| Web | real Vite dev server on `127.0.0.1:5180` |
| Boundary stand-ins | fake Composio client, emulated email/third-party/destination; **no** provider is contacted |

Commands:

```bash
# 1. disposable database (user-space, no root, no Docker)
cd /tmp/e2e-pg && node serve.mjs

# 2. migrate, then create the runtime login so RLS applies
DATABASE_URL=... DATABASE_MIGRATION_URL=... \
  pnpm --filter @matebot/db exec prisma migrate deploy

# 3. browser + API + web
DATABASE_URL=postgres://matebot_app:...@127.0.0.1:55433/matebot_e2e \
DATABASE_MIGRATION_URL=postgres://matebot:...@127.0.0.1:55433/matebot_e2e \
  pnpm exec tsx apps/api/e2e-a2ui.mjs a2ui-live --reporter=list
```

Result: **3 passed (13.7s), exit 0.**

1. Compose card → model-shaped `edit_interaction` → the **same** card shows the
   new subject (`秋后问候`), one `a2ui-email-compose` node, and the card offers
   **Connect email** rather than Send, so nothing was sent.
2. `present_result` → a table with its header, cells, and the provenance line
   (`user-provided CSV`, `CNY`), and no Send/Create control.
3. `calendar.create` with no calendar connection → the card renders and offers no
   Create, so no provider call is possible.

Screenshots: `a2ui-e2e-email-edit.png` and `a2ui-e2e-result-provenance.png`
(the same two frames are saved in this run's artifacts).

## What this E2E does and does not prove

**Proves:** the browser, the app, the router, the executor, the tool entry, the
database, the SSE projection, and the renderer all agree; a tool-shaped edit lands
on the existing card; a result carries provenance; a disconnected calendar cannot
create.

**Does not prove:** that a live model chooses these tools. The runtime here is
`scripted`, so tool selection is a fixed script. That is the Phase 0 gate below.

## Still blocked

| Gate | Why |
|---|---|
| Real DeepSeek multi-turn tool selection (mail, calendar, results) | No authorised `DEEPSEEK_API_KEY` in this environment. The bounded ≤12-scenario live harness and command are documented in [`matebot-a2ui-phase0-validation.md`](./matebot-a2ui-phase0-validation.md); it has not been run |
| Calendar provider slug and argument shape | Patterned on the shipped Composio adapter, never exercised against a real calendar. Treat as unverified integration code |
| Real calendar writes, mail sends, OAuth | Not authorised in this environment |
| Optional interactive charts (P3) | Spec lists them as optional and prerequisite-gated; `render_plot` PNG remains the chart path |

## Reproduction notes

- The launcher takes an already-running Postgres because Docker is unavailable
  here; the container harness (`pnpm test:e2e`) is unchanged and still the
  supported path where Docker exists.
- `apps/web/playwright.config.ts` gained one condition: `PLAYWRIGHT_REUSE_SERVER`
  lets the launcher start Vite itself. CI behaviour is unchanged.
