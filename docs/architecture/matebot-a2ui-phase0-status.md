# A2UI Phase 0 foundation — implementation status

Status of the approved v1.1 spec ([`matebot-a2ui-best-practices-v1.1.md`](./matebot-a2ui-best-practices-v1.1.md)).
This file records **what is actually implemented**; the spec records what is required.
It is updated as each stage lands, and deliberately marks work as deferred rather than done.

Last updated for the Phase 1 calendar PR (base: PR #37 tip `b2085954`).

> **P0 is NOT fully passed.** One pre-release gate remains: a real DeepSeek
> multi-turn run covering **mail and calendar** has not been executed, because no
> task-authorised DeepSeek credential exists in this workspace. Deterministic tool
> tests, an in-memory database, real Postgres, and DOM tests are **not** live-model
> evidence, and the twelve-scenario corpus is a data gate, not an end-to-end run.
> This is an outstanding gate, not a waiver; reproduction instructions are in
> [`matebot-a2ui-phase0-validation.md`](./matebot-a2ui-phase0-validation.md).

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
| The agent loop can revise a card | **Done** | `edit_interaction` tool: registered, offered by selection, dispatched by `applyTool`; proven through the real loop |
| One write path for card edits and prose edits | **Done** | `interaction-field-writer.ts`, shared by both |
| One phase/lock rule for both hosts | **Done** | `emailSurfacePhase`; web and mobile both call it |

## What is deferred (not claimed as done)

| Spec requirement | State | Why |
|---|---|---|
| Email's editor replaced by a generic `FieldsEditor` | **Deferred, deliberately** | Email keeps a thin specialised editor: mailbox connect/reauth and send semantics cannot be expressed by a generic field form, and replacing it would lose them. It now shares the registry, compiler, dispatch, revision rules **and** the phase/lock rule, so what remains is presentation only |
| Calendar draft + real create (Phase 1) | **Deferred** | Registry marks `calendar.create` `implemented: false`, so no dead button ships |
| Result/view surfaces with provenance (Phase 2) | **Deferred** | Corpus rows 1–3 and 6 stay `deferred` with explicit safe fallbacks |
| The 12 scenarios as an executed end-to-end run | **Data gate only** | Registry and invariants are tested, and the sim reports each row; the scenarios are not driven against a live model |
| VegaChart catalog | **Not adopted** | npm 404 at audit; needs license/build/size review |
| Performance targets (p95 ≤ 1s) | **Not measured** | Spec calls these proposals |

## Model constraint for validation

Any Matebot LLM validation is authorised **only** with a DeepSeek provider and
model. Another provider, an "auto" route, or the coding agent's own output is not
accepted as evidence. The authorised command and the exact missing configuration
are in [`matebot-a2ui-phase0-validation.md`](./matebot-a2ui-phase0-validation.md);
`DEEPSEEK_API_KEY` is absent in this workspace, so live model behaviour is
**unverified** rather than assumed.

## Environment blocker: no real database

That blocker is now **resolved** for SQL behaviour: a disposable, unprivileged
PostgreSQL 18.6 runs under `/tmp` (no root, no Docker), the full 221-migration
schema is applied, and `apps/api/src/a2ui-postgres.test.ts` plus
`apps/api/src/a2ui-route-postgres.test.ts` exercise real constraints,
transactions, idempotency, and the real row-level-security policies. See
[`matebot-a2ui-phase0-validation.md`](./matebot-a2ui-phase0-validation.md).

`apps/api/src/a2ui-route.test.ts` still exists and still uses an in-memory
Prisma; it is kept because it is fast and covers request-shape cases that do not
need a server. It is labelled as mock-backed and is not counted as database
evidence.

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
