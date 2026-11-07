# Manual audit remediation plan (2026-11-07)

Source evidence: an 8-round web-UI transcript with one bot in a direct chat, a
read-only server log audit covering 196 tool events across 10 runs, and the
source tree at `872fbea4c585de2e2716ee2724b506ce53f759b2`.

This plan is written to be executed, not reviewed. Each item states what was
actually observed, what the code does, what the root cause is, what changes, and
what test would have caught it. Items that cannot be reproduced from available
evidence are marked blocked rather than "fixed".

## Environment boundaries

| Boundary | State |
|---|---|
| Branch | `cursor/a2ui-manual-audit-remediation-a097`, cut from `872fbea4` |
| Old branches | PR #41 and its ancestors are not rewritten |
| `main` | never merged into, never pushed |
| Deploy / publish | not performed |
| The staging host | not contacted; no config, data, connection, or user key touched |
| Real providers | no real send, calendar write, or OAuth; no real account operations |
| Models | DeepSeek only; no other provider, no fallback |
| Live verification | the maintainer's pause on production acceptance still stands |
| Substitutes | a scripted model and provider doubles are labelled as such, never as live acceptance |

## Evidence levels

**E1** reproduced from source or logs with a failing test. **E2** root cause
identified in source, reproduction requires UI interaction not available here.
**E3** observed once, cause not established. **E4** cannot be established with
current evidence.

---

## A. One trustworthy source for connection and credential state

**Observed.** In the transcript, an MCP card reads `Connected` while the next
turn's assistant text reports `Invalid or revoked API key`, and the log shows
`mcp discovery failed … {"reason": "… Invalid or revoked API key"}`. Later the
user supplies a new key; the assistant says the registered connection still holds
the old one, so its tool button keeps failing, while a shell path using
`$SMARTGATE_KEY` succeeds.

**Root cause — E1.** Two independent facts are collapsed into one word.

- `McpApprovalCard` (`apps/web/src/pages/shell/message-cards.tsx:431`) paints
  `Connected` from the block's `status`, which is set when OAuth completes and the
  assignment is approved (`authorize()` at `:357-372`). It never reads
  `McpServer.healthStatus`.
- `McpServer` already stores the real health: `healthStatus`
  (`unknown | installing | ok | error`), `healthMessage`, `healthToolCount`,
  `healthCheckedAt` (`packages/db/prisma/schema.prisma:1805-1808`).
- Updating a secret does not invalidate anything the running connector holds, so an
  already-registered server keeps serving its old credential while a newly saved
  command variable serves the new one.

**Change.** Make the health row the only source a surface may report:

1. The approval block carries health, not just approval: add `health` (status,
   message, checkedAt, toolCount) to the `mcp_approval` block, projected from
   `McpServer` whenever the block is written or repainted.
2. The card distinguishes the three states explicitly — approved-but-unhealthy must
   not read `Connected`. Copy: `Connected` only when `healthStatus === "ok"`;
   otherwise `Needs attention` with the stored message.
3. Saving a new credential for a server clears `healthStatus` to `unknown`,
   bumps `revision`, and drops any in-process session for that server so the next
   turn re-discovers with the new credential.
4. Health reads and writes are scoped by `spaceId` + `userId` (they already are via
   RLS), and a session cache key is derived from `serverId + revision` so two bots
   or two accounts cannot share one.

**Not in scope.** Shell is not disabled, and command-type credentials keep
working. Only the path where a *connection failure* silently becomes a *new
credential route* is closed (see B).

**Tests (red first).** Health-to-copy mapping (ok/error/unknown); new secret
clears health and bumps revision; a session cached under an old revision is never
reused; concurrent approve+update keeps the newer revision; restart re-discovers
instead of trusting a persisted `ok`.

---

## B. Tool failure classification and credential boundary

**Observed.** `web_fetch` to `rakazo.com` and `web_search` to
`html.duckduckgo.com` both produced `security.event egress.refused` with reason
`URL resolves to a private address`; the model then used `browser_navigate`, which
succeeded.

**Root cause — E1 (partly E4).**

- `web-ssrf.ts:383` throws one message for two different conditions:
  `addresses.length === 0` (resolution returned nothing) **or** any non-public
  address. The log therefore cannot distinguish "DNS gave nothing" from "resolved
  to a private address".
- `browser_navigate` (`browser-tools.ts:111`) validates only scheme and embedded
  credentials. It does not consult the address policy at all. Whether that is
  safe depends on the container's egress, which is runtime configuration this
  audit cannot inspect.

**Change.** Classify and separate, do not weaken:

1. Split the SSRF refusal into distinct reasons: `unresolved` (empty result) and
   `private_address`, keeping redirect and rebinding protections exactly as they
   are. Each carries its own user-facing sentence.
2. Classify tool failures into `security_refused`, `auth_required`, and
   `network_error` in one place, so a card and a log agree on which happened.
3. A target refused by the security policy must not be completed by a fallback
   tool without an explicit approval step. Implement as: record the refused
   `(tool, host)` pair for the run, and if a different network tool is about to
   reach the same host, require approval before it runs. This does not ban
   browser use generally and does not open any allowlist.
4. Public documentation fetches stay unauthenticated: a `secret_request` whose
   destination origin equals the saved origin remains allowed (that check is
   correct and stays), but the tool no longer proposes attaching a credential to
   a documented public path.

**Blocked (E4).** Whether the deployed browser reaches addresses the web tools
refuse is a runtime fact. No code change here claims it either way; the test
asserts only that the *refusal is recorded and cannot be silently routed around*.

---

## C. Product documentation source

**Observed.** The assistant, on a flight task, read the product skill and then
tried to fetch a product doc. The hardcoded list points at
`https://rakazo.com/docs/*.md`, and one observed URL,
`https://rakazo.com/docs/cloud-agents.md`, does not exist in this repository's
docs set at all.

**Root cause — E1.** `packages/adapters/src/builtin-skills.ts:4-38` hardcodes a
list of upstream `rakazo.com` documentation URLs into a skill that ships with
this product. Only the skill's *name and description* inject every turn
(`packages/core/src/agent-skill.ts:121-127`); the body, which contains the URLs,
loads on `skill_read`.

**Change.**

1. Replace the upstream URL list with documentation that exists in *this*
   repository and is served by *this* site. The repo already publishes
   `docs/*.md` through `apps/www` (`apps/www/src/docs.ts` slugs), so the skill
   points at those slugs, not at invented paths.
2. The skill keeps the "fetch then answer" shape but must not fabricate a path:
   the index it carries is generated from the real slug list, so a URL that is in
   the skill is a page that exists.
3. Upstream `rakazo.com` stays reachable when the user explicitly asks about the
   upstream project; nothing is globally blocked.

**Tests (red first).** Every URL in the generated skill resolves to a real doc
slug; no upstream-only host appears in the generated list; the catalog still
injects only name + description.

---

## D. Background command completion lifecycle

**Observed.** Six consecutive assistant bubbles restated the same conclusion
("结论不变，无需重复处理", "不再重复跑命令"), each following a shell command's
tail output.

**Root cause — E1.** `runPromotesMidTurnNarration` (`run-replies.ts:35`) promotes
every mid-turn text segment of a user-triggered run into its own durable bubble.
Nothing correlates a segment with the previous one, so six command tails become
six bubbles.

**Change.** Bound the lifecycle without content-deduplicating real results:

1. Track, per run, how many promoted narration bubbles have been emitted and
   whether the last one already stated the same conclusion, using the run's own
   state rather than text equality across runs.
2. A segment that only reports that a command finished may be folded into the
   next one instead of becoming its own bubble; distinct results are never
   dropped.
3. A late or replayed completion for an already-finished run does not re-emit.
4. A failure is always reported at least once.

**Tests (red first).** Six tails → at most a bounded number of bubbles; two
genuinely different results both survive; a replayed event after completion emits
nothing; a cancelled run emits nothing; a failed run still reports.

---

## E. Intent clarification and factual boundaries

**Observed.** A bare "next week, New York to Tokyo flights" was answered with a
fixed 11/9–11/16 round trip presented as the basis of the search, with prices
attributed to a live source. Separately, an email address was mapped to a GitHub
account by commit authorship, then described with counts that only cover public
repos.

**Root cause — E1.** The model fills a missing parameter and states the fill as
though it were the user's choice. Nothing in the surface path requires a
clarification before a read-only card is produced.

**Change.** Use the existing decision framework rather than a new one:

1. `InteractionDecision` already carries `missingFields`. A query whose window or
   endpoints were never given is a decision with `missingFields`, so the fallback
   is a clarification, not a silently defaulted card.
2. A low-risk default may still be stated *as a default* when the answer is
   read-only and the alternative is a dead end; the wording must say so.
3. Price-like claims require a source the server actually read. With no flight
   source registered, the result is not a price card.
4. Identity wording distinguishes *commit association* from *account ownership*,
   and public-repo counts are labelled as such.

**Tests (red first).** A prompt with no dates yields a clarification decision, not
a card with invented dates; a prompt with explicit dates proceeds; an unattributed
price claim is refused; the association wording is asserted at the behaviour level
(the decision and the rendered card), not by grepping prompt text.

**Blocked (E4).** "Were these prices real?" needs a flight provider this
repository does not have. The fix is that the product no longer presents such
numbers without one.

---

## F. Blank calendar card

**Observed.** After choosing option B, the assistant said the schedule "已排进卡片
（北京时间、周末留空），请在上方卡片确认后创建", and the UI shows an empty frame
where the card should be.

**Root cause — E2.** The log for that run proves a surface was published:

```
19:30:33.233  a2ui.plan_ready
19:30:34.601  a2ui.surface_visible
19:30:34.615  present_interaction succeeded
```

So this is **not** "the backend did not create it". `a2ui.surface_visible` is
emitted inside the publish transaction, after the document is written. The gap is
between publication and client rendering.

**What must be established by reproduction, not assumed.** Whether the document
fails to fetch, compiles to an empty component tree for a batch/`events` plan, or
renders with zero height. The fix follows the reproduction.

**Change (after reproduction).** Whatever the cause, the loading and failure paths
must never leave a blank region: a visible placeholder, a retry, and a
human-readable reason.

**Tests.** A real browser run that drives the calendar surface through the real
API with a scripted model and a provider double, asserting the card is visible,
its buttons are reachable, editing and confirmation work on the same card, and
nothing overflows at desktop and narrow widths. Screenshots attached.

**Explicitly not claimed.** No Windows-native or real-phone verification.

---

## G. Cursor integration state

**Observed.** `connect_app` returned succeeded; the card shows `Connect`; the
assistant says authorization is still needed. An earlier `cloud_agent_status`
call errored.

**Root cause — E1.** `connect_app` is documented as showing a card and waiting
(`builtin-tools.ts:576`), so success means the card was shown. Nothing prevents a
status call from being attempted before any agent exists.

**Change.**

1. The card and the assistant text must never imply a connection exists before
   authorization; the card already renders `Connect`, so the fix is in what the
   turn is allowed to *say* after publishing it — reuse the existing
   surface-nudge discipline rather than new copy rules.
2. `cloud_agent_status` requires an id that came from a launch in this
   conversation; without one it returns "no agent to check yet" rather than
   probing.
3. After authorization, a resume path exists that re-checks and reports real
   status.

**Tests (red first).** Status with no prior launch returns the "no agent" result
and does not call the provider; a successful launch then status reaches the
provider; a cancelled authorization leaves the card in its pre-authorization
state.

---

## H. Audit observability

**Observed.** The log audit could not connect a tool call to its parameters or a
run to what it actually did. 196 events carry tool name, outcome, and duration,
but no `toolCallId`, no non-sensitive URL, and no result summary.

**Change.** Add a redacted, bounded activity record per tool call: tool name,
outcome class, duration, `run.id`, `toolCallId`, and — for network tools — the
registrable host only. Never: request headers, query strings, secret values, user
message bodies, or full URLs with paths that may carry tokens.

**Tests (red first).** A recorded line contains the host but not the path or
query; a secret value never appears; a user message body never appears; the
record is dropped when the feature is off.

---

## Verification gates

| Gate | Command | Required |
|---|---|---|
| Unit + integration | `pnpm vitest run` | no failures |
| Types | `pnpm check` | 24/24 packages |
| Lint | `pnpm lint` | no new errors |
| A2UI simulator | `pnpm test:a2ui-sim` | all rows |
| Server perf | `pnpm test:a2ui-perf` | within budget, boundary stated |
| Browser E2E | `apps/api/e2e-a2ui.mjs` | calendar card at two widths, plus the existing scenarios |
| CI | PR checks | green |

Scripted model and provider doubles are named in every result. No result here is
a live-provider acceptance.

## Coverage matrix

| Item | Evidence level | Status after this work |
|---|---|---|
| A connection/credential single source | E1 | **fixed**: `mcpConnectionVerdict` requires a successful discovery for `connected`; both cards use it, a failure carries the server's own reason. Invalidation already existed (`revision` bump clears health; session cache keyed by revision) and is unchanged. |
| B failure classification + fallback boundary | E1 + E4 (runtime egress) | **fixed (classification and routing)**: an unresolved host and a refused address now report separately, both still refused; a run's refusal ledger stops the browser reaching the host the guard declined. **Blocked (E4)**: whether the deployed browser can reach an address the fetcher refused is runtime configuration this audit cannot inspect, and no claim is made either way. |
| C product doc source | E1 | **fixed (guard + wording)**: every listed URL is now asserted to exist in this repository, so a rename fails the build; the skill says only these pages exist and forbids constructing a path. The list itself was already accurate — the invented URL in the report was never one of them. |
| D background completion lifecycle | E1 | **fixed**: a narration that only repeats one already posted in the run is held for the final reply; genuinely different output and the person's own answer still publish immediately. |
| E intent clarification / factual boundary | E1 + E4 (no flight source) | **fixed (marking + existing refusal)**: a window the assistant chose is recorded as `defaultedWindow` and the card says "dates assumed". A result with no registered source was already refused outright. **Blocked (E4)**: claiming a *live* price needs a flight provider this repository does not have; nothing here invents one. |
| F blank calendar card | E2 → **E1 after reproduction** | **fixed and reproduced**: the plan compiler emitted three text nodes and no field controls, and the calendar normaliser filled a field set that did not match the registered capability. Both are corrected; the real browser card now renders labels, values and the action at wide and narrow widths. |
| G Cursor integration state | E1 | **fixed**: the refusal distinguishes "nothing started yet" from "that id is not here" by querying the thread, so a model with nothing to report has nothing to invent. `connect_app` still only shows a card, unchanged and correct. |
| H audit observability | E1 | **fixed**: a tool completion records the registrable host only — no scheme, path, query, headers or body — beside run, tool, outcome and duration. |

## What is not claimed

- No live DeepSeek run and no live provider call. Every result above is a
  scripted model and provider doubles.
- Windows-native and real-phone rendering are not covered; the browser runs are
  desktop Chromium at two widths.
- The runtime egress boundary in B and the live price claim in E need
  environment evidence the audit cannot obtain.
