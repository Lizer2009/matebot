# 交互卡内核（E 收尾：缺口 + live 8 失败）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Grok 4.6 only — no other-model Task/review/fallback. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the named E leftovers (AC-26 reverse, three-connect boundary, Slack Skip handler, Fake Composio complete→resume) and root-cause the eight full `a2ui-live.spec.ts` failures on head `d0d20c3b8`, without loosening assertions or starting F.

**Architecture:** Spec §8 E + §3.3.2 + §4.1 unique open card. Connection views share `needs_connection`; compose must not stack a second connection card when `connect.{provider}` is already open. `kind: "connect"` stays a compatibility view unless a production writer exists. Slack Skip is the same `deny` id through the production messaging formatter. Fake Composio may stay instant for unrelated tests; the complete-resume path must begin pending and finish through `connections.complete`. Live failures are classified against the spec, then either production is fixed or the test is aligned to an exact clause.

**Tech Stack:** TypeScript, Prisma, Vitest, Playwright live launcher (`pnpm exec tsx apps/api/e2e-a2ui.mjs`), FakeComposio, isolated PG

## Global Constraints

- Grok 4.6 only. Isolated test DB and test identities. No real model/provider, send, Slack delivery, or `.5` / business DB.
- Do not merge, rewrite main, close PR, delete branch, release, or deploy.
- Do not expand paid mechanisms or F (catalog / protocol family).
- Do not skip, delete, or weaken live assertions to go green. If a test conflicts with the spec, cite the clause and change the test to the spec.
- B iOS native / real double-send / real model, and C 30-minute wall-clock queue, stay unverified.
- Commits in English. Do not edit `CHANGELOG.md`.

---

## B / C / D leftovers (still not passing)

Unchanged from E plan. Continuing is not acceptance.

---

## Gap map (from spec §8 E, not from the letter)

| Gap | Spec | Current | This closeout |
|---|---|---|---|
| AC-26 reverse | §3.3.2, AC-26: one connection card per demand | compose→connect skip exists; connect.gmail then compose still opens A2UI `needs_connection` | Skip the second connection view; bidirectional tests |
| `kind: "connect"` | §3.3.2 view of `needs_connection` | Mapping in `l0aIntentForBlock`; no production writer found | Guard: no production `kind: "connect"` write; mapping stays |
| Slack Skip | §14 #11 | Unit only (`approvalDenyLabel`) | Production `run-tool-gate` path with `trigger: "messaging"` + slack identity; not real delivery |
| Fake complete→resume | connections.complete already calls `resumeThreadsWaitingOn` | Fake `authorize` connects instantly (`authorizationUrl: null`) so begin marks `connected` and complete does not resume | Pending-OAuth Fake; begin pending → complete → original card resumes |
| Live 8 | production wiring, not demo fixtures | 11/19 on `d0d20c3b8` | Per-item root cause below; no assertion loosen |

### Live 8 — investigation notes (not yet claimed fixed)

`needs_connection` affordance is `editable: false`, `action: "connect"` (`surface-affordance.ts`). `EDITABLE_STATUSES` / `OPEN_STATUSES` omit `needs_connection`, so `editInteraction` returns `unknown_interaction`. Tests 1/3/4 never call `connections/begin`; the passing approval test does.

| # | Failure | Working hypothesis | Classification if confirmed |
|---|---|---|---|
| 1 | subject stays disabled `Hi` | compose published `needs_connection`; model edit cannot land | **test fixture** missing Fake mailbox. Keep assertions; connect first |
| 2 | result missing `sample-quarters.csv` | `present_result` csv reader needs file blocks on `sourceMessageId` | **product** if attach/read drops the file; **fixture** if send never attaches |
| 3 | `typeSubject` 120s on disabled input | same as #1 | same as #1 |
| 4 | `unknown_interaction` 400 | edit lists only OPEN_STATUSES | same as #1 once connected; do not make `needs_connection` editable (spec §4.3 / affordance) |
| 5 | calendar.query no surface | `present_interaction` is the action-draft tool; `calendar.query` is `cardKind: "result"` | **test vs spec**: drive `present_result` / refuse result intents on present_interaction; never a create draft |
| 6 | two compose expected, got 1 | spec §4.1: one open card per thread+intent; two emails merge | **test vs spec**: expect 1; prove `ambiguous_target` with two *different* intents |
| 7 | re-query missing `2000.5` | same pipeline as #2 | same as #2 |
| 8 | `Starts` vs batch Create | `compile-surface.ts` hides single-event fields when `events` is a batch | **test vs product compiler**: assert batch list + same-card edit, not empty Starts |

---

## Files

| File | Change |
|---|---|
| `packages/adapters/src/run-tools-interaction.ts` + test | AC-26 reverse; refuse result intents on present_interaction |
| `packages/adapters/src/connect-app.test.ts` | keep compose→connect |
| `packages/adapters/src/interaction-kernel-guard.test.ts` | no production `kind: "connect"` writers |
| `packages/adapters/src/run-tool-gate.ts` + test | Slack Skip through production handler |
| `packages/adapters/src/composio-fake.ts` + test | pending OAuth mode |
| `apps/api/src/interaction-connection-recovery.postgres.test.ts` or new | begin pending → complete → resume |
| `apps/web/e2e/a2ui-live.spec.ts` | fixture + spec-aligned cases 5/6/8; connect before 1/3/4 |
| `packages/adapters/src/run-tools-result.ts` | only if #2/#7 is a dropped attachment/sourceMessageId |

---

## Task 1: AC-26 reverse (TDD)

- [ ] **Step 1: failing test** in `run-tools-interaction.test.ts`: thread already has open `connect.gmail` `needs_connection`; `present_interaction` `email.compose` must **not** call `publishOrAmend` with a second `needs_connection` card. Keep existing compose→connect test in `connect-app.test.ts`.

- [ ] **Step 2: run, expect fail**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/run-tools-interaction.test.ts packages/adapters/src/connect-app.test.ts
```

- [ ] **Step 3: implement** — before `publishOrAmend` when capability is `needs_connection`, `findFirst` open `needs_connection` whose intent is `connect.{provider}` (or `connect.{provider}.{accountId}`) and `interactionResumesWhenConnected` for the compose app. Return the existing card; do not publish a second connection view. Named AC-23 cards stay distinct from generic `connect.gmail`.

- [ ] **Step 4: pass + commit**

```bash
git commit -m "feat(adapters): skip compose connection view when connect.gmail is open"
```

---

## Task 2: `kind: connect` boundary

- [ ] Guard test: production (non-test) TypeScript must not write `kind: "connect"` message blocks. Mapping in `l0a-capability.ts` remains. Commit if only a test is added.

---

## Task 3: Slack Skip production handler (no real delivery)

- [ ] Failing test around `showApprovalCard` / `run-tool-gate`: `run.trigger === "messaging"` and `messagingIdentity.provider === "slack"` → deny action label **Skip**, id still `deny`. Web/thread identity stays **Deny**.

- [ ] Implement only if the production branch is missing (it already relabels; the gap is the test). Commit.

---

## Task 4: Fake Composio pending begin → complete → resume

- [ ] Fake: `new FakeComposioClient({ authorize: "pending" })` returns a redirect URL and does **not** `connect()` until complete/waitForConnection. Default stays instant.

- [ ] Isolated PG/API test: present compose (needs_connection) → `connections/begin` pending → `connections/complete` → interaction leaves `needs_connection` via production `resumeThreadsWaitingOn`. No instant begin.

- [ ] Optional live screenshot of resumed draft after complete. If real OAuth is required, record the blocker instead of faking complete.

```bash
git commit -m "test(api): resume the waiting card through connections.complete"
```

---

## Task 5: Live 8 — TDD / spec alignment

For 1/3/4: helper `connectFakeMailbox(page)` via `connections/begin` (instant Fake is allowed here; complete-resume is Task 4). Assertions unchanged.

For 2/7: write a failing adapter/API test of upload + `present_result` `csv-upload` asserting source label and `2000.5`. Fix `sourceMessageId` / file blocks / reader if that is why live is empty. Do not stub numbers.

For 5: `present_interaction` of `calendar.query` returns `unknown_capability` or a dedicated error (result intents are `present_result`). Live test uses `present_result` with `calendar-events` **or** asserts the connect/progress surface is not a create draft. Cite `cardKind: "result"`.

For 6: cite spec §4.1. Same intent twice → count 1, same `interactionId`. `ambiguous_target` with `email.compose` + `calendar.create` both open.

For 8: keep same-card edit; expect batch names (`Weekly sync`, `Follow-up`) not `Starts` when `events` is a batch (compiler `compile-surface.ts`).

- [ ] Do not skip or weaken other live assertions.

---

## Task 6: Grok 4.6 review + verify on the final SHA

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src packages/adapters/src apps/api/src \
  apps/web/src/components/a2ui apps/web/src/pages/shell apps/mobile/lib

pnpm --filter @matebot/core --filter @matebot/adapters --filter @matebot/db \
  --filter @matebot/contracts --filter @matebot/api --filter @matebot/web \
  --filter @matebot/mobile check

pnpm lint

# isolated PG suite from E plan Task 9, plus new complete-resume file

pnpm exec tsx apps/api/e2e-a2ui.mjs a2ui-live.spec.ts
```

After any fix, re-run the whole related group. Screenshots to `/opt/cursor/artifacts/`. Push PR 50. Stop. Do not start F.
