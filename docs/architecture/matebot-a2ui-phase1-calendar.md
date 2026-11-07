# A2UI Phase 1 — calendar as the second domain

Status of Phase 1 of the approved v1.1 spec
([`matebot-a2ui-best-practices-v1.1.md`](./matebot-a2ui-best-practices-v1.1.md)).
Phase 0's outstanding gate is recorded in
[`matebot-a2ui-phase0-status.md`](./matebot-a2ui-phase0-status.md) and is **not**
cleared by this phase.

Base: PR #37 tip `b2085954`.

---

## What Phase 1 required

From spec §8 Phase 1 and §5.4: a calendar draft or `FieldsEditor`; real provider
creation; timezone / all-day / partial batch; queries render a result rather than
a draft; cross-platform; and a simulator that tells the truth instead of forcing
email stamps over the gap.

## What this phase implements

| Requirement | State | Evidence |
|---|---|---|
| Calendar is a registered capability on the shared pipeline | **Done** | `calendar.create` in `packages/core/src/interaction-capability.ts`, `implemented: true`, its own field schema and one `create` action |
| Query is a distinct read-only capability | **Done** | `calendar.query`: `presentation: "result"`, no action, `effectKind: null` — a read cannot become a write |
| Start/end ordering, timezone, all-day validation | **Done** | `packages/core/src/calendar-event.ts`; 16 tests |
| Default timezone Asia/Shanghai, explicit override honoured | **Done** | `validateCalendarEvent`; tested both ways |
| All-day events snap to local midnights | **Done** | `localMidnightIso`; tested in a +08:00 zone |
| Real provider creation through the existing connector architecture | **Done** | `packages/adapters/src/interaction-calendar.ts` (`GOOGLECALENDAR_CREATE_EVENT`), injected sender, no default-constructed client |
| Creation runs the shared effect lifecycle | **Done** | `executeConfirmedInteractionService` calendar branch: same claim → ambiguous → completed/failed, same `finishInteractionEmailSend` projection |
| UNKNOWN reconciles, never auto-retries | **Done** | Calendar failures route through `emailDeliveryOutcome` and `scheduleReconcile` exactly as email does |
| Duplicate submit is idempotent | **Done** | Pre-claim `completed` short-circuit; tested (`duplicate: true`, provider not called) |
| Connection/reauth preflight is source-aware | **Done** | `resolveCapabilityConnection` uses calendar preflight for `calendar.*`, mailbox for email |
| A disconnected calendar refreshes the card, then refuses | **Done** | `projectCapabilityGate` mirrors the mailbox behaviour |
| No attendees are ever invited | **Done** | No attendee field exists; the create call never sets one; tested |
| Simulator reports the real capability | **Done** | `simulateCalendarSurface` reports presentation/action/state, no forced email stencil |

## What this phase deliberately does not do

| Item | Why |
|---|---|
| Partial batch (multiple events, partial success) | Not required to prove calendar is a genuine second domain. It needs a result surface that reports per-event outcomes, which is Phase 2's result contract |
| Calendar editing of an existing provider event | The spec's Phase 1 scope is create + read. Editing a remote event is a different effect with its own reconciliation |
| Real provider reads/writes in tests | Authorisation here covers no calendar writes and no OAuth change; provider behaviour is demonstrated with doubles |
| Mobile calendar-specific editor | Mobile renders the generic compiled form (Phase 0 parity); the calendar adds no native-only surface |

## Acceptance status

| Spec §9.4 scenario | Status | Evidence |
|---|---|---|
| Draft is editable, primary button is Create | **Done** | Capability schema is a form with one `create` action; DOM tests cover the generic form |
| Timezone defaults to Asia/Shanghai, override works, start/end consistent | **Done** | `calendar-event.test.ts` |
| Partial batch distinguished | **Not implemented** | Deferred, see above |
| No unrequested invites or batch creation | **Done** | No attendee field; tested |
| "Next week" renders a result, not a draft | **Done (capability)** | `calendar.query` is a result with no action. The live read path is wired but not exercised against a provider here |
| Real provider execution, layered with sim | **Mocked only** | `interaction-calendar.test.ts` drives the real service with a provider double; no live calendar call was authorised |
| Cross-platform | **Partial** | Web renders via the shared compiler/host; mobile renders the generic form. No calendar-specific native editor |

## Honest limits

- **No live model run.** Nothing here shows a DeepSeek model choosing
  `present_interaction` with `calendar.create`, or correcting a calendar draft in
  prose. That is the same P0 gate, and it now also covers calendar.
- **No live provider call.** The connector code follows the shipped Composio
  pattern, but the tool slug and argument shape have not been exercised against a
  real calendar. Treat that as unverified integration code.
- **No real Postgres run for the calendar path.** The Phase 0 Postgres suites are
  unchanged and still apply to the shared tables; the calendar branch adds no new
  SQL. It can be exercised with the documented `/tmp` Postgres procedure.

## Reproduction

```bash
# calendar validation, no credentials or network
pnpm vitest run packages/core/src/calendar-event.test.ts

# calendar create through the shared execute service, with a provider double
pnpm vitest run apps/api/src/interaction-calendar.test.ts

# capability registry and the corpus phase tags
pnpm vitest run packages/core/src/interaction-capability.test.ts packages/core/src/corpus.test.ts

# the whole matrix, including the calendar rows
pnpm test:a2ui-sim
```
