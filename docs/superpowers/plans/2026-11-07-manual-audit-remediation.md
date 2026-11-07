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

Every sub-goal below is tracked on its own, because "8 items, 6 fixed" hid real
gaps: an item counted as fixed while a named part of it was not.

### A. Connection and credential state

| Sub-goal | Evidence | Status |
|---|---|---|
| A1 health, not approval, decides the verdict | E1 | **already correct**: `mcpConnectionVerdict` needs a successful discovery for `connected`; the web and mobile cards both use it. |
| A2 a failure carries the server's own reason | E1 | **already correct**: `sanitizeConnectorError` keeps the provider's sentence; the audit's `Invalid or revoked API key` reaches the card. |
| A3 saving clears the old verdict | E1 | **fixed**: `MCP_HEALTH_RESET` is one definition of the reset, used by the update route. |
| A4 new key → re-discovery → recovered UI, as one chain | E1 | **fixed and proven**: `apps/api/src/mcp-credential-recovery.test.ts` drives the real router, real connector and real encrypted store against a scripted server that rejects the old key and answers the new one. It asserts the failure is recorded, the save clears it, the check re-discovers with the new key, and the settings list agrees. Removing the reset makes it fail. |
| A5 a failed connection cannot become a new shell credential | E1 | **already correct, now pinned twice**: a command variable has no origin to be sent to, so the *shape* that could spend it cannot be stored (`bot-secrets.test.ts`), and `requestWithBotSecret` refuses it at request time. A login is refused outside `browser_act`. The command variable's own use — exported for shell — is untouched. |
| A6 concurrent update / isolation | E1 | **already correct**: the update path retries on a changed revision or credential and refuses with CONFLICT; isolation is covered by `refuses another user's server without probing it`. |

### B. Failure classification and the execution boundary

| Sub-goal | Evidence | Status |
|---|---|---|
| B1 split "unresolved" from "private address" | E1 | **fixed**: `EGRESS_REASON_UNRESOLVED` and `EGRESS_REASON_PRIVATE_ADDRESS` are separate sentences, both still refused. |
| B2 classify a failure by structure, not by wording | E1 | **fixed**: `tool-failure.ts` reads an error's class, `code` and HTTP status (following a `cause`), and consults a message only for the two sentences our own guard produces. A refusal is checked first, so it cannot be recorded as a network error; a message that merely mentions a private address is never classified as a refusal. |
| B3 the record joins a request to its completion | E1 | **fixed**: the completion carries `executionId` (the same id `agent.tool.called` was written with) plus a `failure { class, detail }`, and the log line carries both. Covered by an assertion on the events a real turn appends. |
| B4 a refused destination cannot be reached by another tool | E1 | **fixed**: the run's ledger is keyed by one canonical destination, so a trailing root dot, an expanded IPv6 address and an IPv4-mapped form all match; the browser refuses it, and shell is refused before it runs when the command names it. |
| B5 what that barrier cannot see | E3 | **stated, not claimed away**: a command that assembles its address at run time names no literal, so the shell check does not see it. The boundary that holds is the computer's own network policy. `browser-egress-fallback.test.ts` asserts the blind spot so the limit is a fact rather than a claim. |
| B6 SSRF redirect, rebinding and host alias | E1 | **unchanged and covered**: every redirect hop is re-validated, the proxy tunnels to the checked address, and a rebinding answer is refused (`web-ssrf.test.ts`). The canonical destination key closes the alias gap in the *ledger*, not in the fetch. |
| B7 does the deployed browser reach what the fetcher refused | E4 | **blocked**: runtime network configuration this audit cannot inspect. No claim is made either way; the deployment gate is listed below. |

### C. Product documentation source

| Sub-goal | Evidence | Status |
|---|---|---|
| C1 the help skill describes this product | E1 | **fixed**: the upstream host is gone from the skill. `PRODUCT_DOCUMENTATION` lists this repository's own pages, and the origin comes from deployment configuration (`RAKAZO_MARKETING_URL`), not a literal. |
| C2 every listed page exists | E1 | **fixed**: `product-docs.test.ts` fails when a slug has no `docs/<slug>.md`, and when the list drifts from the site's own navigation. |
| C3 no invented URL | E1 | **fixed**: the list is a closed set and each entry is built from the slug, so a URL in the skill is a page that ships. The observed `/docs/cloud-agents/` is asserted absent. |
| C4 `skill_read` answers Cursor/MCP setup with no network | E1 | **fixed and proven at the production entry**: `skill-read-product-docs.test.ts` calls the real `skillReadFromTool` and checks the answer covers MCP connection, approvals and Cursor cloud agents from the offline fallback, and that the model is told not to construct a path. |

### D. Background completion lifecycle

| Sub-goal | Evidence | Status |
|---|---|---|
| D1 a repeated conclusion is one bubble | E1 | **fixed**: the restatement check now guards the mid-turn publish path as well as a steering turn, and a held note is kept once. |
| D2 a genuinely different result is never swallowed | E1 | **fixed**: only a note that normalises to one already posted is held; anything with new content publishes. |
| D3 the person's own answer always publishes | E1 | **fixed**: the steering path publishes an answer at once, asserted. |
| D4 a restart holds what the run already posted | E1 | **fixed**: the reply state is rebuilt from the run's own progress messages, so a restarted attempt cannot post the same note again. |
| D5 cancellation and late events | E1 | **already correct, now asserted**: what was written before the run stopped stands; nothing written after reaches the chat, and a completion that arrives after a cancelled run does not fail it. |
| D6 cross-run isolation | E1 | **already correct**: nothing is compared across runs, so two runs reaching the same conclusion both report. |

### E. Intent clarification and factual boundaries

| Sub-goal | Evidence | Status |
|---|---|---|
| E1 a missing key parameter is asked about, not defaulted | E1 | **fixed**: `windowDecision` has three outcomes. A period the person stated is theirs; one the model admits choosing is published *and* said out loud; one nobody stated is refused with a question, in `present_result` and `refresh_result` alike. |
| E2 an assumption is never presented as the person's choice | E1 | **fixed**: the card's provenance line says "dates assumed" and the reply the server writes carries it too, so the model can repeat it but not restate it as the user's own. |
| E3 the identity boundary is stated where the lookup happens | E1 | **fixed (instruction, honestly labelled)**: the desktop instruction says an association is not proof of ownership, labels a repo count as public repositories, and requires naming a source and its date. This is guidance to the model, not an enforced fact — E4 below says what would be needed to enforce it. |
| E4 a price claim without a source | E1 | **already correct**: a result with no registered source is refused. Nothing invents one. |
| E5 "were those prices real?" | E4 | **blocked**: needs a flight provider this repository does not have. The code now refuses to present such a number without one; it does not acquire one. |

### F. Calendar card

| Sub-goal | Evidence | Status |
|---|---|---|
| F1 the draft draws real controls | E1 | **fixed**: a plan's fields compile to the schema's control kinds, asserted through the production publish path (`interaction-calendar-card.test.ts`) and on the mounted renderer. |
| F2 each label appears once | E1 | **fixed by reproduction**: the browser showed every label twice, because the compiler emitted a Text label *and* the shipped control draws its own. The Text is gone; the E2E counts the occurrences. |
| F3 a batch list travels without being drawn | E1 | **fixed**: the list reaches the execute path and no control is bound to it, asserted at both levels. |
| F4 loading and failure never leave a blank region | E1 | **fixed**: a server ref with no fetcher, an empty document and a failed fetch each render a sentence and a retry; the renderer's own loading frame draws a placeholder rather than an empty div. |
| F5 a field the person typed survives a late edit | E1 | **fixed by reproduction**: the editor adopted every server snapshot wholesale, so a re-render could replace typed text (and a second edit could append to it). A field the person edited now wins until the server's value is the typed one. |
| F6 same card, both widths, nothing clipped | E1 | **fixed by reproduction**: a date-time row measured 324px inside a 216px card at narrow width. The row wraps and its inputs shrink; the E2E measures every control against the card and the viewport at 1280 and 360. |
| F7 timezone | E1 | **fixed**: the timezone travels as a value and is shown in its own control, asserted live. |
| F8 native Windows and real phones | E4 | **not verified**: no Windows desktop or phone was available. The browser runs are desktop Chromium at two widths, and the mobile card's own logic has unit coverage only. |

### G. Cursor integration state

| Sub-goal | Evidence | Status |
|---|---|---|
| G1 the card never claims a connection before authorization | E1 | **already correct**: `connect_app` only shows a card. |
| G2 a status call with no launch | E1 | **already correct**: it returns "no agent to check yet" without probing. |
| G3 tenant isolation is not traded for a nicer sentence | E1 | **confirmed by a failed attempt**: distinguishing "nothing launched" from "a wrong id" told a caller in another space that the thread was otherwise empty. The isolation test caught it and the code is unchanged. |
| G4 a repeated code or OAuth card is not re-requested after cancellation | E1 | **already correct**: a dismissed card settles the effect as completed with `{ dismissed: true }`, so a resumed attempt replays that result instead of asking again. |

### H. Audit observability

| Sub-goal | Evidence | Status |
|---|---|---|
| H1 run, tool id and tool name on every completion | E1 | **already correct**. |
| H2 the same id on the request and the completion | E1 | **fixed**: both events carry the execution id, and the log line carries it as `tool.call_id`. |
| H3 the destination origin and a safe path | E1 | **fixed**: the origin is always recorded; a path only for a page this build ships or a route the caller declares low-risk. |
| H4 a word-like path is not assumed safe | E1 | **fixed**: `/users/alex`, a short token and a private slug are withheld with a marker, because shape is not evidence. |
| H5 query, fragment, userinfo, headers and body are never recorded | E1 | **already correct, now asserted** including the destination round trip. |
| H6 what kind of failure it was | E1 | **fixed**: a class from structured signals, with the detail being a code or status rather than a message. |
| H7 a user message body is never recorded | E1 | **already correct**: only the tool's own text and metadata are touched, and every string is redacted against the run's secrets. |

## Deployment gates (not verifiable here)

These need a deployment, a real provider, or a specific device, and no claim above
depends on them:

- **Live DeepSeek and real providers.** Every model and provider in this work is a
  scripted double. Tool *selection* by a live model, and any real MCP server, mailbox
  or calendar, are unverified.
- **The deployed browser's egress.** Whether the browser host can reach addresses the
  fetcher refuses is runtime configuration. `B7` states the barrier and its blind
  spot; measuring them is a deployment check.
- **DNS and network from the deployment.** The audit's `egress.refused` entries were
  not reproduced against the production network, so the split reasons are proven in
  code, not in that environment.
- **Windows-native and real-phone rendering.** Covered by neither the browser suite
  nor any device here.
- **OAuth, real sends and calendar writes.** Not exercised; the audit's pauses on
  production acceptance stand.

## What is not claimed

- No live DeepSeek run and no live provider call. Every result above is a scripted
  model and provider double, and says so where it is used.
- The runtime egress boundary in B and the price claim in E need environment
  evidence this audit cannot obtain.
- The identity wording in E3 is instruction to the model. Nothing enforces that a
  model repeats it, and no test asserts a model's prose.
