# A2UI Phase 2 — result surfaces

Status of Phase 2 of the approved v1.1 spec
([`matebot-a2ui-best-practices-v1.1.md`](./matebot-a2ui-best-practices-v1.1.md)).
Phase 0's live-model gate and Phase 1's provider-integration gap are recorded in
their own docs and are **not** cleared by this phase.

Base: PR #38 tip `ede779bb0`.

---

## What the spec requires

§5.6 (result contract), §7.1 (sales analysis, file/search results), §9.5
(connection, local/remote, charts) and §8 Phase 2: a result contract with
provenance, lists and tables first, `render_plot` retained, mobile degrades to
PNG or a table, and no fabricated series — with no data the assistant asks for a
source.

§5.7 lists **VegaChart and any future advanced table as P3, optional**. Phase 2
is explicitly the list/table stage.

## What this phase implements

| Requirement | State | Evidence |
|---|---|---|
| Result contract with provenance | **Done** | `packages/core/src/interaction-result.ts`: `validateResultProvenance`, `buildResultSurface`; 19 tests |
| `source` and `asOf` are mandatory | **Done** | A result with no source is refused, not rendered |
| Empty ≠ zero | **Done** | `empty` flag plus a sentence naming the source; DOM test asserts the notice, not `0` |
| Bounded datasets | **Done** | `RESULT_MAX_ROWS` (200), `truncated`/`totalRows`, a visible "showing the first N of M" line |
| Scalar-only cells | **Done** | Nested objects and arrays are refused (`unsupported_row_value`) |
| Table from basic primitives only | **Done** | Header Row of Texts + one Row per record; no Table/DataGrid is claimed |
| Trusted compiler emits the table | **Done** | `buildResultComponents` in `packages/a2ui-adapter/src/compile-surface.ts` |
| Production tool entry | **Done** | `present_result` is a declared model tool (`builtin-tools.ts`), dispatched through `applyTool`; 6 loop tests |
| Real server publish path | **Done** | `packages/adapters/src/interaction-result-publish.ts` writes Interaction + Surface + message block + SSE |
| Result is read-only by construction | **Done** | No effect writer exists on the path; the loop test asserts no `email.send`/`calendar.create` effect is created |
| Same-card re-query | **Done** | `refreshResultSurface`: changes window/rows, preserves source/units/zone, refuses a silent source change; 6 tests |
| Stale refresh rejected | **Done** | Reuses `acceptSurfaceEvent` (equal or older revision is dropped) |
| Web rendering | **Done** | Real `@a2ui/react` DOM tests: header labels, cell values, provenance line, empty notice, zero inputs and zero buttons |
| Simulator honesty | **Done** | `result-surface` row: no-source refused, empty flagged, oversized truncated, re-query keeps units, silent source change refused |

## What this phase does not do

| Item | Why |
|---|---|
| VegaChart or an advanced table catalog | Spec §5.7 puts these in **P3, optional**; they need license, build, CSP and bundle review first. Claiming interactive charts without a registered catalog, compiler path and host would be false |
| Remote re-query through a provider | A window change that needs fresh provider data would force a backend read with its own permissions. Phase 2 validates and refreshes what the server was given; it does not fetch |
| Mobile-specific table widget | Mobile renders the generic compiled tree; a wide table degrades to stacked rows. No calendar/result-native surface was added |
| Aggregation | Deliberately absent: callers compute deterministically and pass rows. This validator will not invent or reshape numbers |

## Honest limits

- **Charts are PNG, not A2UI.** The shipped chart path remains `render_plot` →
  PNG on Web. There is no interactive chart on an A2UI surface, and this phase
  does not add one.
- **Not live-model verified.** Same gate as Phase 0: no authorised DeepSeek
  credential exists here, so nothing shows a real model choosing
  `present_result` or re-querying a card in prose.
- **No real browser end-to-end.** Web rendering is proven by DOM tests against the
  real renderer, not by driving the full application.
- **Calendar query retrieval is still unverified** (Phase 1 note): the capability
  and its surface type exist, but the read pipeline has never run against a
  provider. Phase 2 does not connect it.

## Reproduction

```bash
# contract and validation
pnpm --filter @matebot/core test -- interaction-result result-refresh

# compiler emits a real table
pnpm --filter @matebot/a2ui-adapter test -- compile-surface

# production tool loop, with a publish double
pnpm --filter @matebot/adapters test -- run-tools-result-loop

# real renderer DOM
pnpm --filter @matebot/web test -- generic-surface.dom

# the whole matrix, including result-surface
pnpm test:a2ui-sim
```
