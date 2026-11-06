# A2UI Phase 0 foundation — implementation status

Status of the approved v1.1 spec ([`matebot-a2ui-best-practices-v1.1.md`](./matebot-a2ui-best-practices-v1.1.md)).
This file records **what is actually implemented**; the spec records what is required.
It is updated as each stage lands, and deliberately marks work as deferred rather than done.

Last updated for the first foundation PR (base: PR #33 tip `ebca31d5b`).

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
| Email migrated onto the shared shell (`FieldsEditor` path) | **Deferred** | Email still uses its dedicated editor and lifecycle; both work, and the migration is its own change |
| RPC route executes the real effect for a dispatched action | **Partially wired** | The route + service checks are in place; `runAction` currently confirms the action is valid but does not invoke the existing confirm/execute path. **This is the next change and is load-bearing.** |
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

## Deliberate design notes

- **No new tables and no new packages.** The capability entry is keyed by intent;
  the interaction row already stores its intent, so no migration was needed.
- **Approval is derived**, not read from a status column: `confirmedVersion === draftVersion`.
  A stale or edited draft therefore cannot submit on an old approval.
- **Action context is bound to the data model** (`interactionId`, `revision` paths)
  rather than literals, so a click reports the draft it was rendered from.
- **A registered capability may be unimplemented.** `calendar.create` is registered
  with `implemented: false` precisely so it is recognized without pretending it works.
