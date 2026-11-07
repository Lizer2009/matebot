# A2UI v1.1 closeout: spec-by-spec completion matrix

The authoritative document is
[`matebot-a2ui-best-practices-v1.1.md`](./matebot-a2ui-best-practices-v1.1.md).
This page records, for each spec requirement, **where it is implemented, which
test exercises it from a real entry point, what kind of evidence that is, and
what remains blocked.** It is deliberately not a "done" summary: rows that are
still blocked say so.

Base: PR #40 tip `7f831b4a`. This branch sits on top and leaves #33–#40 untouched.

## How to read the evidence column

| Kind | What it means |
|---|---|
| **browser E2E** | Real Chromium → real web app → real oRPC router → real executor → real migrated Postgres, driven through `apps/api/e2e-a2ui.mjs`. The model is a *scripted stand-in* that calls the production tools. |
| **real PG** | The real route over a migrated Postgres with real transactions and row-level security (`VERIFY_DATABASE=1`). |
| **route HTTP** | The real oRPC router and handlers over HTTP, in-memory database. Proves wiring, not SQL. |
| **tool loop** | `applyTool` — the same entry the executor uses — with a real handler and a doubled datastore. |
| **unit** | A pure function. Necessary but never sufficient on its own. |

## §5 Core contracts

| Spec | Implementation | Test entry | Evidence | Remaining |
|---|---|---|---|---|
| §5.1 shared lifecycle shell | `packages/core/src/interaction-template.ts` | `interaction-surface-phase.test.ts`, browser E2E 1/3 | unit + browser E2E | none |
| §5.1 no per-app parallel templates | one template table; calendar reuses it | `interaction-capability.test.ts` | unit | none |
| §5.1 default `FieldsEditor(schema)` | `packages/a2ui-adapter/src/compile-surface.ts` | `compile-surface.test.ts`, `generic-surface.dom.test.tsx` | unit + DOM | none |
| §5.2.1 capability declares schema, connection, effect kind | `packages/core/src/interaction-capability.ts` | `interaction-capability.test.ts` | unit | none |
| §5.2.2 a local read-only source needs no remote connection | `result-source.ts` (`csv-upload`, `requiresConnection: null`) | `result-source.test.ts`; browser E2E 8 | unit + browser E2E | the shipped local source still has no real upload reader behind it |
| §5.2.3 unregistered intent → refusal + human-readable fallback | `present_interaction` validates the decision before publishing | `run-tools-result-attribution.test.ts`, `interaction-decision.test.ts` | unit + tool loop | none |
| §5.2.4 per-surface `schemaVersion` | `ResultSurfaceSchema`/`InteractionSurfaceSchema`; version pinned per surface | `compile-surface.test.ts` | unit | negotiation is a field, not a handshake — no v1_0 host exists yet |
| §5.3.1 plan/decision untrusted, validated server-side | `compile-surface.ts` parse; decision validated in `present_interaction` | `compile-surface.test.ts`, `interaction-decision.test.ts` | unit + tool loop | none |
| §5.3.2 model cannot emit code/HTML/URL | `apps/web/src/components/a2ui/catalog-guard.ts` | `catalog-guard.test.ts` | unit | none |
| §5.3.3 action allowlist + ids + revision binding | `action-bridge.ts`, `interaction-dispatch.ts` | `action-bridge.test.ts`, `interaction-dispatch.test.ts` | unit | none |
| §5.3.4 idempotency, stale revision refused | `interaction-dispatch.ts`; DB unique key | `a2ui-postgres.test.ts` (real PG), browser E2E 5 | real PG + browser E2E | none |
| §5.3.5 confirmation bound to exact revision | `canDispatchSurfaceAction` | `a2ui-phase0-loop.test.ts` | unit + loop | none |
| §5.3.6 editing an approved payload voids the approval | field writer sets `confirmedVersion: null` | browser E2E 6, real PG field test | browser E2E + real PG | none |
| §5.3.7 resume ≠ auto-send; UNKNOWN only reconciles | `interaction-resume.ts`; service has no auto-retry | `interaction-resume.test.ts` | unit | none |
| §5.3.8 no host-side send route | clients only call `dispatchInteractionAction` | browser E2E 1 | browser E2E | none |

## §5.4 Calendar

| Spec | Implementation | Test entry | Evidence | Remaining |
|---|---|---|---|---|
| §5.4.1 editable name/time/timezone/all-day | `CALENDAR_SCHEMA` | `calendar-event.test.ts` | unit | none |
| §5.4.1 default `Asia/Shanghai`, explicit override | `validateCalendarEvent` | `calendar-event.test.ts` | unit | none |
| §5.4.2 partial batch is distinguishable | `calendar-batch.ts`, `interaction-calendar-batch.ts`, execute service | `interaction-calendar-batch.test.ts` (adapter + execute path) | tool loop + execute service | **a real provider has never run a batch** — same block as single create |
| §5.4.3 query is a result, never a create draft | `calendar.query` capability; `readCalendarEvents` behind `calendar-events` | `result-source-calendar.test.ts`, browser E2E 7 | tool loop + browser E2E | provider slug/args unverified against a live calendar |
| §5.4.4 shared lifecycle for the second domain | same templates | `interaction-calendar.test.ts` | execute service | none |

## §5.5 / §5.6 Results

| Spec | Implementation | Test entry | Evidence | Remaining |
|---|---|---|---|---|
| §5.5.2 old email snapshots still render | `overlayAuthoritativeA2uiBlocks` | `a2ui-recovery.test.ts` | unit + DOM | none |
| §5.6.1 provenance source/window/units/year/timezone/freshness | `interaction-result.ts`, `ResultProvenanceSchema` | `interaction-result.test.ts` | unit | none |
| §5.6.1 empty ≠ a real zero | `emptyResultNotice` | DOM test, browser E2E 8 | DOM + browser E2E | none |
| §5.6.2 aggregation computed by deterministic code | `result-aggregate.ts`, used by `present_result` and `resolveSourceBackedRows` | `result-aggregate.test.ts`, `result-source-calendar.test.ts` | unit + tool loop | none |
| §5.6.2 the model may not invent a series | rows the model writes are marked `attribution: "model"` and say so on the card | `run-tools-result-attribution.test.ts` | unit + tool loop | a model can still *claim* rows; the card now says they were not read |
| §5.6.3 switching window keeps source and unit | `republishResultSurface` refuses a different source; `refresh_result` reads through the registered source | `interaction-result-republish.test.ts`, `run-tools-result-refresh.test.ts` | unit + tool loop | none |
| §5.6.4 remote re-query keeps backend authorization | reader built per turn from the run's own connector | `result-source-calendar.test.ts` | tool loop | real provider unverified |
| §5.6.6 basic has no Table/DataGrid; simple tables use Row/Column | `compile-surface.ts` emits Row+Text | `compile-surface.test.ts`, `a2ui-result-mobile.test.ts` | unit + mobile | none |
| §9.5 mobile table fallback keeps provenance | `a2ui-catalog.ts` renders `Row` stacked; nothing dropped | `a2ui-result-mobile.test.ts` (incl. narrow-screen row) | mobile unit | no simulator screenshot for the table; the web E2E covers the same document |

## §6 Interaction decision and multi-turn

| Spec | Implementation | Test entry | Evidence | Remaining |
|---|---|---|---|---|
| §6.3 `InteractionDecision` + server ruling | `interaction-decision.ts`, schema in `interaction-surface.ts`, enforced in `present_interaction` | `interaction-decision.test.ts` | unit + tool loop | nothing forces the *model* to emit a decision object; the server validates the plan's intent as the candidate |
| §6.4.1 NL edit and direct edit update the same card | `applyNaturalLanguageEdit` writes through the field service | browser E2E 1/4, real PG | browser E2E + real PG | none |
| §6.4.2 optimistic concurrency on exact revision | `canSubmitSurface` | browser E2E 5, real PG stale test | browser E2E + real PG | none |
| §6.4.3 a typed field is protected from a late model edit | field stamped `source: "user"`; protected set derived from the persisted plan | `run-tools-interaction-edit-protection.test.ts`, browser E2E 4, real PG protection test | tool loop + browser E2E + real PG | none |
| §6.4.4 stale or out-of-order SSE events discarded | `preferA2uiSurfaceBlock` guards on `draftVersion`, called by both hosts | `a2ui-recovery.test.ts`, browser E2E 5 | unit + browser E2E | none: the one guard both hosts call is the version comparison; the unused stricter variant was deleted rather than left as a second rule |
| §6.4.5 a genuinely new task opens a new card | tools create their own interaction | browser E2E 1, real PG one-card test | browser E2E + real PG | none |
| §6.4.6 executed records are immutable; corrections are linked drafts | `edit_interaction` → `buildAmendment` → new draft naming the record | `run-tools-interaction-amend.test.ts`, real PG executed-cancel test | tool loop + real PG | the amended draft has never been *executed* against a real provider |
| §6.4.8 editing an approved payload voids approval | `confirmedVersion: null` on every field write | browser E2E 6 | browser E2E | none |
| §6.5.1 in-flight action disables the primary control | `EmailComposeEditor` busy state; idempotent dispatch | DOM tests | DOM | none |
| §6.5.2 cancel only before the effect runs; no false undo | `interaction-cancel.ts`, `threads.cancelInteraction`, Discard on both hosts, `cancel_interaction` tool | `a2ui-cancel-route.test.ts`, `run-tools-interaction-cancel.test.ts`, browser E2E 7, real PG | route HTTP + tool loop + browser E2E + real PG | abort signalling to a running provider is not implemented; the cancel is refused while in flight, which is the safe half |
| §6.5.3 drafts survive load, reauth, cross-device | `overlayAuthoritativeA2uiBlocks` | `a2ui-recovery.test.ts` | unit | none |
| §6.5.4 UNKNOWN only reconciles | `reconcileConfirmedInteractionService` | `interaction-email-reconcile.test.ts` | unit | none |

## §7.2 The twelve-scenario corpus

Run `pnpm test:a2ui-sim` for the table. Status per row, honestly:

| # | Scenario | Status | Evidence kind | Note |
|---|---|---|---|---|
| 1 | annual sales, real data | deferred | — | no sales data source is wired; a card would have to invent numbers |
| 2 | then "last quarter" | deferred | — | same block |
| 3 | sales with no source | deferred | — | the refusal exists; the data path it refuses does not |
| 4 | next week's schedule | implemented | unit + browser E2E 7 | read goes through the registered source; provider unverified |
| 5 | book a meeting, missing time | implemented | unit + execute service | provider unverified |
| 6 | analyse this file | deferred | — | no file-analysis reader is wired |
| 7 | write an email, then NL-edit the recipient | implemented | browser E2E 1/4 + real PG | send is a provider double |
| 8 | simple factual question | implemented | browser E2E 8 | renders no card |
| 9 | GitHub to this machine | unsupported | sim | degrades by design |
| 10 | multiple cards, "change it" | implemented | `surface-target.test.ts` | none |
| 11 | auth interrupted, then resume | implemented | `interaction-resume.test.ts` | no auto-execute after resume |
| 12 | in-flight send plus a read query | implemented | DOM busy state | none |

**Rows 1, 2, 3 and 6 are not implemented and are not claimed.** Their block is
the missing data source, which is a product decision (where do the numbers come
from), not an A2UI mechanism gap.

## §9.6 Instrumentation and performance

| Spec | State | Evidence |
|---|---|---|
| seven named moments | `a2ui-timing.ts` defines all seven; `surface-visible` and `provider-result` are emitted from the real publish and execute paths | unit; both emit sites are on the production path |
| a card counts as first feedback | `run-timing.ts` includes `a2ui_surface` in response kinds | unit; this was previously missing, so an A2UI-only turn recorded no first response |
| p95 reproducible | `pnpm test:a2ui-perf` | script prints p50/p95/max for five workloads and fails above budget |

The measurement excludes model and network time on purpose, so the number
describes this repository's own work and reproduces anywhere.

## What remains blocked, and what would clear it

| Block | Kind | Clears when |
|---|---|---|
| Live DeepSeek has never selected these tools | verification | a `DEEPSEEK_API_KEY` is provided to this environment; then the corpus can be run against the live model |
| Calendar provider slug and arguments are unverified | verification | one real calendar connection plus one create and one read |
| Email send and calendar write are unexercised against a real provider | authorization | explicit permission for a real send / real event |
| Sales and file-analysis data sources do not exist | product | a decision on where those numbers come from |

## Dead code removed rather than counted as done

Four helpers existed in `@matebot/core` with no production caller. Each had a
shipped equivalent, so keeping them would have let a passing unit test stand in
for a behaviour nothing ran. They are deleted, and the test that named them now
exercises the production path instead:

| Removed | The behaviour it described, where it actually ships |
|---|---|
| `acceptSurfaceEvent` | `preferA2uiSurfaceBlock` in `a2ui-recovery.ts` — the `draftVersion` comparison both hosts call |
| `applySurfaceEdit` | `applyNaturalLanguageEdit` plus the `source: "user"` stamp; the protection is on the persisted plan |
| `refreshResultSurface` | `run-tools-result-refresh.ts` reads the registered source and calls `republishResultSurface` |
| `resolveInteractionSender` | the inline capability branch in `executeConfirmedInteractionService`, now covered by a test |

`readCalendarEvents` is no longer dead: the calendar result reader calls it.

## Commands used for this closeout

```bash
pnpm vitest run                                    # full suite
pnpm check                                         # 24 packages typecheck
pnpm lint                                          # note: pre-existing errors on the base branch
pnpm test:a2ui-sim                                 # corpus and invariant rows
pnpm test:a2ui-perf                                # server-side p50/p95
node scripts/a2ui-perf.mjs --runs 1000             # more samples
```

Real-database and browser runs need a disposable database; they are skipped
without one, which is why CI does not cover them:

```bash
DATABASE_URL=... DATABASE_MIGRATION_URL=... pnpm vitest run apps/api/src/<name>.postgres.test.ts
DATABASE_URL=... DATABASE_MIGRATION_URL=... ./node_modules/.bin/tsx apps/api/e2e-a2ui.mjs e2e/a2ui-live.spec.ts
```
