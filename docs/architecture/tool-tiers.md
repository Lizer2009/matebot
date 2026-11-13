# Tool tiers: one catalog, four sources

Goal: a run's tool list is decided by one function, in tiers a user can predict, and
every tool a bot can use is reachable from the same discovery verb whether it is a
built-in, a connected app, a self-hosted service, or a registered MCP server.

## Why

A run today carries two unrelated loading schemes and one source with no limit at
all, so one capability can be spelled up to five different ways in a single tool
list:

- Built-ins split into 30 residents plus `find_tool` / `use_tool`
  (`packages/adapters/src/builtin-tool-bridge.ts`).
- The MCP connector, the installed-capability connector and the Pipedream connector
  each swap their whole toolset for `*_search_tools` / `*_load_tool` /
  `*_execute_tool` once they pass `DIRECT_TOOL_LIMIT` (20).
- The connected-apps connector has no limit: it returns every session tool,
  including its own search and multi-execute meta tools
  (`packages/adapters/src/composio-connector.ts`, `discoverTools`).

Each of those is defensible alone. Together they cost the model accuracy, because a
model choosing a tool sees four near-identical discovery verbs and has no signal
about which source a capability lives in. The budget is also per connector, not per
run: three connectors at 20 tools plus the residents can all be visible at once.

A second asymmetry is inside the bridge itself. `find_tool` always inlines the whole
name index of every deferred tool, with no size check, so its own description grows
with each tool the product adds; `lazyCatalogTools` does check the index against
`NAME_INDEX_MAX_NAMES` / `NAME_INDEX_MAX_BYTES` and degrades to a source summary
instead. Only one of the two discovery verbs is bounded.

A third, user-visible failure comes from the same place. When every connection for a
source is revoked, the connected-apps connector returns `[]` and its tools vanish
mid-conversation with no explanation. The model then reaches for `shell` and writes
its own client instead of telling the user to reconnect. The MCP connector already
answers this with a `*__unavailable` placeholder tool; the other sources do not.

## What the code does today

```
selectBuiltinToolsForRun()            run-tool-selection.ts   ~90 built-ins, filtered per run
        +
connector.discoverTools(context)      executor.ts             each connector decides alone
        v
tools = [...builtins, ...connector]   executor.ts             the only merge point
        v
toAgentTools()                        pi-runtime-tools.ts
        v
partitionTools()                      builtin-tool-bridge.ts  the only resident/deferred split
        v
   30 core built-ins resident, the rest behind find_tool/use_tool
   every connector tool listed as-is
```

`partitionTools` is the right seam: it already receives the merged list and already
decides what the model sees. It only recognizes built-in names, so connector tools
pass through unconditionally.

| Tier | Source in this repository | Route | Budget today |
| --- | --- | --- | --- |
| 1 Basic CLI | `builtin-tools.ts`, ~90 tools | no route | 30 resident |
| 2 Connected apps | `ComposioConnector` | `composio` | none |
| 3 Self-hosted | `McpConnector` (`mcp_servers` + `bot_mcp_servers`), `InstalledConnectors` (`capability_install`), `PipedreamConnector` | `mcp`, `installed`, `pipedream` | 20 each |
| 4 Registered MCP | also `McpConnector`: the same table and the same route | `mcp` | 20, shared with tier 3 |

Tier 3 and tier 4 are not distinguishable in code. A registered server and a
self-hosted one are rows in `mcp_servers` with nothing to tell them apart, so no
policy can treat them differently today.

Tier 1 has no `ssh` tool. `ssh` is a command a run types into `shell`, so anything
reachable only that way looks like work with no tool and invites the model to build a
client instead. A remote host that should be reached through a checked path has to be
a tier 3 tool; leaving it to `shell` is the friction described next.

## Why a model writes its own client

Cataloging is necessary for a smooth run and not sufficient for it. Four things make
`shell` plus a hand-written client the shortest path, and the tiers above address only
the first:

| Cause | Addressed by |
| --- | --- |
| A source whose connections are all revoked returns `[]`, so its tools vanish with no explanation | Tiers: the `unavailable` entry |
| Integration credentials sit in the bot computer's shell environment | Deployment: remove them |
| Remote MCP refuses redirects while a hand-written client follows them | Remote fetch policy: bounded follow |
| No prompt rule forbids implementing an integration by hand | Prompt and tool descriptions |

**Credentials in the shell.** Nothing in this repository injects integration
credentials into a bot's computer; the computer image's `user-env.sh` handles only
identity. A key placed there by a deployment makes one line of `python` with a
hand-written HTTP request cheaper than discovery, authorization and approval, so no
amount of tool design wins against it. It is also the plainest security exposure in
the run, which makes removing it the right first move regardless.

**Redirects.** `createSafeRemoteFetch` requests every endpoint with
`redirect: "manual"` and turns any 3xx into `ConnectorRedirectError`, which marks the
server unhealthy, so the model is shown `*__unavailable` for a server that answers
fine over curl or `urllib`. The platform is stricter than the fallback it competes
with, which rewards the fallback. `inspectSafeRemoteUrl` already validates every URL
it is given, so following a bounded number of hops and re-validating each one keeps
the same protection without punishing a correct server. Note that a redirect from an
HTTPS endpoint to a different host is exactly the case SSRF protection exists for;
the follow must re-check each hop, not just the first.

**Prompt.** No instruction anywhere tells the model not to implement an integration
itself; the only such signal is the MCP connector's `*__unavailable` description. A
run that has a tool for a job must reach for it, and a run that has none must say so
rather than open a socket.

## Decisions

1. **One catalog.** `partitionTools` becomes the single place that decides resident
   versus catalog, for built-ins and connector tools alike. The three
   `lazyCatalogTools(...)` call sites in the connectors go away; `resolveCall` keeps
   handling catalog ids so checkpoints and approved effects written by an older
   release still replay.
2. **Tiers come from the route, not from a new registry.** One function,
   `toolTier(tool)`, maps `tool.route` to 1-4. No connector changes what it returns,
   and no new table is needed for tiers 1-3.
3. **One run budget, allocated by tier.** A run lists at most 35 tools and 12 KB of
   definitions. Within that: tier 1 takes what it needs (see open question 1), tier 2
   keeps two frequent tools per connected app, tier 3 stays direct only while it has
   three tools or fewer, and tier 4 is catalog-only.
4. **`find_tool` is the only discovery verb.** It already returns full schemas for
   exact `names` or a ranked `query`. It gains a `tier` filter, and an empty call
   lists sources by tier instead of one flat name index. Its name index gets the same
   `fitsNameIndexBudget` check `lazyCatalogTools` already applies, so a large catalog
   degrades to a source summary rather than a growing description. `use_tool` does not
   change: it resolves the real tool and runs it through the same gate, approvals,
   checkpoint and audit as a direct call, which is the security argument for
   cataloging at all.
5. **An assigned source that is down stays visible.** Every source that has no tools
   because its connection is missing, revoked or failing contributes one
   `unavailable` entry, in the same shape as the MCP connector's
   `mcp__<slug>__unavailable`, naming what to tell the user.
6. **Registered and self-hosted servers get a column.** `mcp_servers` gains
   `origin` (`self` | `registry`, default `self`). Adding a column is safe under the
   deploy rules; without it tier 4 cannot exist and the policy stays a guess about
   endpoints.
7. **A correct server must not be punished for redirecting.** Remote MCP follows a
   bounded number of redirects, re-validating every hop with the same address checks
   that guard the first request. Static SSRF defenses stay; only the blanket refusal
   goes.
8. **A run that has a tool does not build a client.** One prompt line says so, and it
   is enforceable: an eval asserts that a request naming a connected app produces a
   tool call and no shell command that opens a socket to it.

## Tasks

### 1. Stop the unbounded source (P0)

- [ ] The connected-apps connector respects the same limit as the others, so its
      toolsets never arrive whole.
- [ ] It contributes an `unavailable` entry when connections exist but none is live,
      and when a toolkit needs reconnecting.
- [ ] Test: discovery with no live connection returns one placeholder and no real
      tools; discovery over the limit returns the catalog wrappers.

### 1b. Remove the reason to hand-write a client (P0, not a code change here)

- [ ] Deployment: no integration credential in a bot computer's environment. Check
      each running computer's environment, not just the compose file.
- [ ] Remote MCP follows redirects with a hop limit, re-validating each hop through
      `inspectSafeRemoteUrl`; `ConnectorRedirectError` remains for a chain that
      exceeds the limit or leaves the allowed shape.
- [ ] Test: a server that redirects once to its canonical URL discovers its tools; a
      chain past the limit and a hop to a private address both fail closed.
- [ ] The endpoint the Integrations screen accepts is the canonical one, so the
      common case never redirects.
- [ ] Prompt: one line that a run uses the tool it has and says so when it has none,
      instead of opening a socket. The `unavailable` descriptions repeat it in the
      place the model is looking.
- [ ] Eval: a request naming a connected app calls its tool, and no shell command in
      the run opens a socket to that service.

### 2. One catalog (P1)

- [ ] `toolTier(tool)` in `builtin-tool-bridge.ts`, derived from `tool.route`;
      unit tests for a built-in, an app tool, a self-hosted install and an MCP tool.
- [ ] `partitionTools` defers connector tools over the per-tier budget, keyed by the
      name the model actually sees: `toAgentTools` must register deferred tools under
      their normalized name so `use_tool` and `find_tool` agree, including names that
      need normalizing.
- [ ] `find_tool` takes `tier`; its description groups sources by tier, and both its
      name index and `lazyCatalogTools` go through one shared budget check.
- [ ] Delete the three `lazyCatalogTools(...)` call sites; keep `resolveCall`.
- [ ] The byte budget test in `builtin-tool-bridge.test.ts` covers the merged list,
      not only built-ins, and its pinned names are updated once.

### 3. Separate registered from self-hosted (P2)

- [ ] Add `mcp_servers.origin` with a default, and record it when a server is added
      from the registry or by hand.
- [ ] Show the two groups separately in Integrations, in the same dropdown that
      already assigns servers to bots.

### 4. Measure (P3)

- [ ] Record the offered tool count and definition bytes per run (the eval harness
      already computes both in `packages/testkit/src/evals/tool-calls.ts`), so the
      budget is visible in production and not only in CI.
- [ ] Re-run the tool-choice suite before and after; results decide open question 1.

## Verification

- Deterministic: `partitionTools` allocates by tier and never exceeds the budget;
  no catalog wrapper appears when a source is small; a deferred connector tool is
  runnable through `use_tool` under its normalized name; the placeholder entry is
  produced for each unavailable source.
- Evals: a capability in each tier is found and used; a common task never calls
  `find_tool`; `use_tool` is never called on an unknown or unloaded name.
- Negative evals: a task that names a connected app or a registered server produces
  that tool's call and no shell command that opens a socket to the service; a task
  whose only path is `shell` still uses `shell` rather than claiming a tool exists.
- Compatibility: a checkpoint and an approved effect written with
  `__catalog_execute` still replay.
- All of it offline by default; live model runs only through the eval CLI.

## Constraints

- Public repository: tests and fixtures are synthetic.
- The approved-effect and checkpoint paths are security-sensitive. Cataloging must
  never skip a gate: `use_tool` keeps executing the real tool, and the gate keys on
  the real tool's route.
- Keep provider names in adapters. Tiers describe where a capability comes from, not
  which vendor supplies it.
- Separate PRs: 1, then 1b, then 2, then 3, then 4. 1b's deployment step is not a
  pull request and lands independently.

## Open questions

1. **How small is tier 1?** Residents are 30 named tools but the enforced list is 23
   with a 31,932-byte budget, while `docs/settings-from-chat-tasks.md` still says
   12-15. Sinking `attach_file`, `end_call`, `schedule_list` and `read_history` saves
   context and costs one `find_tool` round trip on those tasks. The tool-choice suite
   should decide this, not taste.
2. **Should a revoked connection auto-suggest reconnecting in the reply?** The
   placeholder makes the model aware; whether the run should also offer a
   `connect_app` card unprompted is a product decision.
3. **How many redirect hops?** One covers a trailing-slash or scheme upgrade; more
   covers a gateway that moved. Each extra hop is another validated address, so the
   cost is a round trip, not a weaker check.
