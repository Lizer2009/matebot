# A2UI Phase 0 foundation — implementation status

Status of the approved v1.1 spec ([`matebot-a2ui-best-practices-v1.1.md`](./matebot-a2ui-best-practices-v1.1.md)).
This file records **what is actually implemented**; the spec records what is required.
It is updated as each stage lands, and deliberately marks work as deferred rather than done.

Last updated for the second foundation PR (base: PR #34 tip `df36eb755`).

---

## What landed in this PR

| Spec requirement | State | Evidence |
|---|---|---|
| L1 Capability Registry (server owns intent, fields, connection, effect) | **Done** | `packages/core/src/interaction-capability.ts`; tests in `interaction-capability.test.ts` |
| L3 Trusted compiler: field schema → real controls | **Done** | `packages/a2ui-adapter/src/compile-surface.ts`; DOM tests in `apps/web/.../generic-surface.dom.test.tsx` |
| L4 Generic action bridge (allowlist, ownership, surface, revision, idempotent) | **Done** | `packages/a2ui-adapter/src/action-bridge.ts`, `apps/api/src/interaction-dispatch.ts`; 22 tests |
| L4 Host passes `actionHandler` to the renderer | **Done** | `A2uiSurfaceHost.tsx`; real-click DOM test |
| Stable revision, stale/out-of-order drops, user-field protection, approved-payload invalidation, immutable executed record | **Done (pure functions)** | `packages/core/src/surface-revision.ts`; 15 tests |
| Unknown intent / unimplemented capability → explicit safe fallback, no action | **Done** | `packages/core/src/interaction-plan-bridge.ts`; sim `capability-registry` |
| Result surface requires no editable nodes | **Done** | compiler + DOM tests |

## What is deferred (not claimed as done)

| Spec requirement | State | Why |
|---|---|---|
| Model-driven NL editing reaches the same surface | **Done** | `apps/api/src/interaction-nl-edit.ts` + `threads.editInteraction`; writes through the card's own field service and republishes that surface. Route test in `a2ui-route.test.ts` |
| Ambiguous reference across several cards asks instead of guessing | **Done** | `packages/core/src/surface-target.ts`; 7 tests |
| Route-level HTTP integration for edit + dispatch | **Done (in-memory Prisma)** | `apps/api/src/a2ui-route.test.ts`: real router, middleware, handler, HTTP body. No SQL/transaction coverage — see blocker below |
| Mobile generic parity: fields and actions on device | **Done** | `apps/mobile/lib/a2ui-catalog.ts` carries variant/path/action; native press test |
| 12-scenario corpus as a phase-aware gate | **Done (data gate)** | `packages/core/src/corpus.ts` + `corpus.test.ts` + sim `corpus-gate`; only 5 rows are implemented |
| RPC route executes the real effect for a dispatched action | **Done** | `interaction-dispatch.ts` + `interaction-run-action.ts`: the click confirms the exact revision then runs the existing execute service. No parallel route. Tests in `interaction-dispatch.test.ts`, `interaction-run-action.test.ts` |
| Route-level integration test (click → effect through HTTP) | **Not run** | No Postgres/Docker in this environment; covered at service level and by the real-DOM click test instead |
| Multi-turn prose edits reaching the same surface | **Deferred** | Pure revision rules exist; nothing drives them from a model turn yet |
| Mobile parity for the generic compiler | **Deferred** | Mobile still allows 5 components; explicit fallback, no dropped action |
| Calendar draft + real create (Phase 1) | **Deferred** | Registry marks `calendar.create` `implemented: false`, so no dead button ships |
| Result/view surfaces with provenance (Phase 2) | **Deferred** | Registry has one read-only result intent as a rule proof only |
| VegaChart catalog | **Not adopted** | npm 404 at audit; needs license/build/size review |
| Performance targets (p95 ≤ 1s) | **Not measured** | Spec calls these proposals |
| 12-scenario corpus as a gate | **Not run** | Defined in the spec; only sim rows exist today |

## How to verify locally

```bash
pnpm --filter @matebot/a2ui-adapter test      # compiler + bridge
pnpm --filter @matebot/core test              # registry, revision, fallback
pnpm --filter @matebot/web test               # real-renderer DOM integration
pnpm --filter @matebot/api test               # dispatch service
pnpm test:a2ui-sim                            # matrix, including capability-registry
```

The DOM tests mount the real `@a2ui/react` renderer on trees the real compiler
produced, so a regression to a text-only card fails them. The simulator runs the
shipping core functions and exits nonzero when a row contradicts its invariant.

## Environment blocker: no real database

The route-level test (`apps/api/src/a2ui-route.test.ts`) drives the real oRPC
router over real HTTP with an in-memory Prisma client, because this environment
has no Postgres, no Docker, and no root to install either. That covers routing,
middleware, request/response shape, validation, and the service logic. It does
**not** cover SQL constraints, transaction isolation, or row security — those
remain the `.postgres.test.ts` suites, which need a database and were not run
here. Integration evidence was not silently replaced with pure unit tests; the
gap is named.

## Deliberate design notes

- **No new tables and no new packages.** The capability entry is keyed by intent;
  the interaction row already stores its intent, so no migration was needed.
- **Approval is derived**, not read from a status column: `confirmedVersion === draftVersion`.
  A stale or edited draft therefore cannot submit on an old approval.
- **Action context is bound to the data model** (`interactionId`, `revision` paths)
  rather than literals, so a click reports the draft it was rendered from.
- **A registered capability may be unimplemented.** `calendar.create` is registered
  with `implemented: false` precisely so it is recognized without pretending it works.
- **One write path.** A prose edit and a direct field edit call the same
  `updateInteractionFieldService`, so they cannot drift; the prose path only adds
  target resolution and user-field protection.
- **The corpus is data, not handlers.** Twelve rows declare class, phase, status,
  and safe fallback; adding a capability moves rows to `implemented` without a
  new prompt-specific branch.
