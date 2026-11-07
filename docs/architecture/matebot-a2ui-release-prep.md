# Release preparation for this branch (not a release)

This page is what a coordinator needs in order to publish this branch and test it
on `192.168.10.5` and on a user machine. **Nothing here has been done** — no
image was built, nothing was pushed to a registry, no server was contacted, no
installer was produced. The conditions below are not met yet, so publishing now
would be premature.

## Status: the gate is not satisfied

| Condition the maintainer set | State |
|---|---|
| All spec gaps in scope closed | yes, see [`matebot-a2ui-v1.1-closeout.md`](./matebot-a2ui-v1.1-closeout.md) |
| Full regression, end-to-end and performance run | yes, results below |
| **Real DeepSeek verified live** | **no** — no credential in this environment |
| **Real calendar provider verified** | **no** — slug/args never called against a live calendar |
| Real email send / calendar write / OAuth | **not authorized**, unchanged |

The first two rows are done. The third and fourth are not, so the conditional
permission to publish has not been earned and no release step is performed here.

## Exact revision

| Item | Value |
|---|---|
| Branch | `cursor/a2ui-spec-closeout-a097` |
| Base | `cursor/a2ui-remaining-e2e-a097` (PR #40 tip `7f831b4a`) |
| PR | #41 |
| Merge state | open, **not merged**; no merge is authorized |

Record the branch head commit at the moment you publish. The branch moves as
review feedback lands, so a tag cut from it later refers to whatever that SHA is
then; take the SHA from `git rev-parse origin/cursor/a2ui-spec-closeout-a097` at
that moment rather than from this page.

## What this branch changes that a deployment must know

| Area | Change | Migration |
|---|---|---|
| Database | none — no new tables, columns, or enums | **none required** |
| Dependencies | none added, none upgraded | none |
| Feature flag | `FEATURE_A2UI` still defaults **off** | none |
| Protocol family | `v0_9` stays the default; `v1_0` remains reserved | none |
| Wire contracts | `threads.cancelInteraction` added; `present_result` input narrowed (source required) | backwards compatible: an old client simply never calls the new route |
| Surface documents | a result surface can carry per-item batch rows | additive; older hosts ignore unknown columns |

Because there is no migration, the previous release keeps working unchanged
against the same database — which is the property the project requires when an
old API overlaps a new worker.

## Build entries that exist today

These are the shipped definitions; none was invoked in this run.

| Target | Entry | Notes |
|---|---|---|
| Server image | `.github/workflows/publish-server-image.yml` | release tags `v*`; images also tagged `sha-<commit>` and `edge` from `ci.yml` |
| Desktop installer | `.github/workflows/release-desktop.yml` | release tags `v*` or manual dispatch; builds macOS/Windows/Linux and verifies `latest-*.yml` against the release version |
| Compose stack | `infra/compose/docker-compose.yml` via `pnpm compose:up` | smoke checks: `pnpm test:compose-smoke` |
| Desktop app version | `apps/desktop/package.json` → `0.6.0` | bump in the release PR, not in a feature PR |
| Workspace version | root `package.json` → `0.1.0` | |

`pnpm build` (turbo) produces the workspace build; `pnpm check` typechecks all 24
packages; `pnpm lint` is Biome.

## Version identification

Two identifiers answer "which build is this":

- The commit SHA, from `git rev-parse HEAD` on the branch that was published.
- The image tag, `sha-<commit>` for a main-line build, or the `v*` tag for a
  release. A compose deployment should pin the `sha-` tag so a moving `edge`
  cannot change a server underneath a test.

Record both together. An image tag without its commit cannot be tied to a diff.

## Notes for updating `192.168.10.5`

These are observations from the change set, not verified against that host — this
run never contacted it.

- **No migration to apply.** If the host runs migrations on start, the command
  succeeds and changes nothing.
- **Flag stays off by default.** A deployed instance will behave exactly as it
  does today until `FEATURE_A2UI` is set. Turning it on is a deliberate step to
  test this work, and turning it off is the rollback.
- **The old API stays valid.** With no schema change and no dependency change,
  the previous image can run against the same database, so rolling back is
  redeploying the previous tag rather than restoring data.
- **What to check after switching the flag on:** a mail draft renders with a
  single Send; Send is disabled when no mailbox is connected; an edit after
  approval removes that approval; Discard cancels an unrun draft; an executed
  record cannot be cancelled.

## Notes for the user machine

- The desktop app bundles the web UI; it is the same rendering path the browser
  E2E exercised.
- Nothing in this change alters onboarding, auth, or local storage, so an
  existing install upgrades in place.
- If the desktop app is pointed at a server running the old image, the only
  visible difference is that Discard still does nothing and result cards require
  a server that understands the narrowed `present_result` input.

## Verification results to attach to the release

| Check | Result |
|---|---|
| `pnpm vitest run` | 22,308 passed, 0 failed |
| `pnpm check` | 24/24 packages |
| `pnpm lint` | 0 errors (40 pre-existing warnings, unchanged from the base) |
| Browser E2E (real app, router, executor, migrated Postgres) | 12/12 scenarios |
| Real-Postgres route suites (transactions, RLS) | 24 passed |
| `pnpm test:a2ui-sim` | all rows hold |
| `pnpm test:a2ui-perf` | turn server CPU work p95 ≈ 0.05 ms over 1000 samples — server-only, not a turn latency |
| Compose installer smokes | pass (the key-body check was broken on the base and is fixed here) |

## What must clear before publishing

1. A DeepSeek credential in this environment, then the twelve-scenario corpus run
   against the live model. Until that happens, "the model picks these tools" is
   still unproven and must be stated as such in any release note.
2. One real calendar connection exercised through create and read, to confirm the
   provider's tool name and argument shape.
3. Explicit permission for a real send and a real calendar write, which this run
   does not have and does not request implicitly.

Until 1–3 are recorded, a release note for this branch must say that the
capability is verified against provider doubles and a scripted model, not against
a live model or a live calendar.
