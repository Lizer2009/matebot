# Phase 0 real validation: what was actually executed

This records the P0 validation run authorised by t237 and t238. It exists because
"the tests pass" was ambiguous: earlier runs used controlled tool calls and an
in-memory Prisma, and those are not the same evidence as a live model or a real
database. Each row below states exactly which kind of evidence it is.

Base: PR #36 `cursor/a2ui-phase0-edit-tool-a097` @ `b0ba77108a77b9e40ed35b2708a327b080713a50`.

---

## Model constraint (hard requirement)

**Only DeepSeek is authorised for Matebot LLM validation.** The coding agent
running this task is itself a DeepSeek model (`deepseek-v41-flash-1017`), but that
is *not* evidence that the Matebot production loop used a live model — it is the
author of these changes, not a participant in them. Do not substitute another
provider, an "auto" route, or the coding agent's own reasoning as validation.

Authorised configuration, when it exists:

```bash
pnpm test:evals --live --provider deepseek --model deepseek-flash \
  --api-key-env DEEPSEEK_API_KEY --trials 1
```

`--provider deepseek` is wired in `packages/core/src/model-providers.ts`; the
harness reads the key from the named environment variable and never from the
command line (`packages/testkit/src/cli/evals.ts`).

## Evidence matrix

| Layer | Kind of evidence | Status |
|---|---|---|
| Tool registration and selection | Deterministic unit tests | **Passed** |
| Tool loop dispatch (`applyTool` → `edit_interaction`) | Controlled model stand-in, no LLM | **Passed** |
| HTTP route over memory Prisma | Real router, mocked database | **Passed** |
| HTTP route over **real Postgres** | Real router, real schema, real transactions | **Passed** |
| SQL constraints, transactions, RLS | Real Postgres 18.6, real migrated schema | **Passed** |
| **Live DeepSeek model choosing tools** | Real model inference | **BLOCKED — see below** |
| Real provider send / calendar write | Forbidden by authorisation | **Not run, by design** |

## Live model: blocked, and why

`DEEPSEEK_API_KEY` is **absent** from this environment, as are
`DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL`. No `DEEPSEEK_*` variable is set and no
local model server is listening (ports 11434/1234/8080/8000 closed; no `ollama`,
`llama-server`, or `vllm` binary).

What is required to unblock, none of which this run may create:

1. A DeepSeek API key, provided as the environment variable `DEEPSEEK_API_KEY`
   through the sanctioned secret path (Cloud Agents → Secrets, or the deployment's
   own `.env`), never committed and never pasted into a command.
2. Optional: `DEEPSEEK_BASE_URL` if the account uses a non-default endpoint.
3. Confirmation that spending on that account is acceptable for a bounded run
   (≤12 short synthetic scenarios, 1 trial each).

With that in place the command above runs the live tool-selection check. Until
then, the honest statement is **live model behaviour is unverified**, and the
twelve-scenario corpus remains a data gate, not a measured result.

## Real Postgres: executed

| Item | Value |
|---|---|
| Distribution | `embedded-postgres` 18.6.0-beta.19, unprivileged, data under `/tmp/pgtest/data` |
| Server | PostgreSQL **18.6** on `127.0.0.1:55432` |
| Database | `a2ui_validation` (created by this run) |
| Migrations applied | **221** via `prisma migrate deploy`, including `20261125120000_a2ui_interactions` |
| Public tables | 113 |
| Roles | `matebot_test` (owner/migrator), `matebot_app` (runtime, subject to RLS) |
| RLS | **Real policies present**: `interactions_tenant`, `interactions_system`, and the same pair on `interaction_surfaces`; `relrowsecurity = true` |

Commands (values exported for the shell only; the password is a throwaway local
fixture, not a credential for any hosted system):

```bash
# start (user space, no root, no Docker)
cd /tmp/pgtest && node serve.mjs

# migrate the disposable database
DATABASE_URL=postgres://matebot_test:...@127.0.0.1:55432/a2ui_validation \
DATABASE_MIGRATION_URL=... pnpm --filter @matebot/db exec prisma migrate deploy

# SQL-level guarantees
DATABASE_URL=postgres://matebot_app:...@127.0.0.1:55432/a2ui_validation \
DATABASE_MIGRATION_URL=postgres://matebot_test:...@127.0.0.1:55432/a2ui_validation \
VERIFY_DATABASE=1 pnpm vitest run apps/api/src/a2ui-postgres.test.ts

# real router over the same database
... FEATURE_A2UI=1 pnpm vitest run apps/api/src/a2ui-route-postgres.test.ts
```

Both exit **0**. See "Observed counts" below.

### What the SQL tests actually assert

- A real `interactions` row and its `interaction_surfaces` row persist from one
  transaction, read back through a query (not from the response body).
- A version-guarded `updateMany` succeeds once and then reports `count: 0` for a
  second writer holding the stale version — a genuine race, in SQL.
- The `idempotencyKey` unique constraint rejects a duplicate effect at the
  database, not in application code.
- Five concurrent inserts for one key create exactly **one** row.
- A transaction whose second insert fails leaves **no** trace of the first.
- Row-level security hides another tenant's interaction from the same query, and
  refuses an insert that claims a space the caller does not own. Both use the
  policies actually present in `pg_policy`; this is not an application check.

### RLS: tested, with its real shape

The `interactions_tenant` policy is `FOR ALL USING (spaceId = app.space_id)` with
**no `WITH CHECK`**. Postgres therefore applies the `USING` expression to inserts
too, which the cross-tenant insert test confirms by being refused. This is stated
because "RLS enabled" and "RLS rejects the write you care about" are different
claims.

## Observed counts

| Command | Exit | Result |
|---|---|---|
| `vitest run apps/api/src/a2ui-postgres.test.ts` | 0 | 7 passed |
| `vitest run apps/api/src/a2ui-route-postgres.test.ts` | 0 | 4 passed |
| `vitest run` (full suite) | see PR | one pre-existing failure, below |

**Pre-existing failure, reproduced at base:** `packages/testkit/src/compose-installer-smoke.test.ts`
→ `FAIL: key-body: check passed an image with a secret`. It fails identically on
the untouched base commit and is unrelated to A2UI.

## Cleanup

This run created, and only created: the disposable database `a2ui_validation`,
the `matebot_app` role, the `/tmp/pgtest` distribution and data directory, and
rows whose ids start with `a2ui-verify` or `a2ui-rt`. Test files delete their own
rows in `afterAll`. Nothing outside `/tmp` and those rows was modified; no
production host, schema, or URL was touched.

## Still not proven

- A live model choosing `edit_interaction` from a natural follow-up.
- Any real provider effect: sends, calendar writes, OAuth. Forbidden here.
- UI end-to-end in a browser. The renderer is covered by DOM tests against the
  real `@a2ui/react`; the full app loop was not driven.
