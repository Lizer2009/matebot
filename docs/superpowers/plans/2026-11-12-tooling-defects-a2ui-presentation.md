# Tooling defects and A2UI presentation contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix catalog/gate/body defects (D2/D3/D4/D6/D8) without changing public contracts, then (after explicit approval) lock the A2UI presentation contract (D1, `effectKind` as string, ask-card copy) so later product intents follow spec §6.1 instead of another framework pass.

**Architecture:** One pipeline stays: model `tool_call` → `gateToolCall` (keyed on `route`) → builtin handler, connector execute, `ask` (pauses run), or `present_interaction` (compiles `a2ui_surface`, does not pause). Track A only repairs classification, budgets, metadata, placeholders, and capability lookup. Track B only adds history projection, widens `effectKind`, and improves ask titles; it does not add product intents.

**Tech Stack:** TypeScript, Vitest (`pnpm exec vitest run <file>` from repo root), existing Matebot packages (`@matebot/core`, `@matebot/adapters`, `@matebot/a2ui-adapter`, `@matebot/adapter-kit`). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-12-tooling-defects-a2ui-presentation-design.md`
- Do not add product intents (`calendar.delete` / `calendar.update` / per-app cards). Future intents use spec §6.1 (code, not ops config).
- Do not auto-build A2UI from connector `inputSchema`. Do not inject uninstalled plugin skill bodies.
- Do not rename tools. Keep `catalogToolPrefix` mapping `mcp` → `connectors`.
- Do not make A2UI clicks resume a run. Keep `present_*` on `APPROVAL_EXEMPT_TOOLS`.
- Do not execute plugin repository code on the control plane. Do not land `tool-tiers.md`. Do not integrate SimuLang.
- Track B (Tasks 6–8) must not be implemented until the maintainer approves the presentation-contract change.
- Preserve today's `computerSupportsTerminal` / `computerSupportsUpdate` boolean results per kind; only change *where* those booleans are stored (`describe().capabilities`).
- Commits: do not skip hooks; do not change git config. If author identity is missing, leave changes staged and stop.
- Tests from repo root: `pnpm exec vitest run <paths>`

## File map

| File | Responsibility |
|---|---|
| `packages/adapters/src/run-tool-selection.ts` | `BUILTIN_AGENT_TOOL_NAMES` includes agent-connection tools |
| `packages/core/src/action-approval.ts` | `connect_agent` / `message_agent` require approval |
| `packages/adapters/src/builtin-tool-bridge.ts` | `find_tool` name-index budget |
| `packages/adapters/src/lazy-tool-catalog.ts` | export `sourceSummaryText` for the same degrade path |
| `packages/adapters/src/composio-connector.ts` | `readOnly` mapping + unavailable placeholder |
| `packages/adapters/src/pipedream-connector.ts` | per-app unavailable placeholder |
| `packages/adapter-kit/src/types.ts` | `SandboxCapabilities.inPlaceUpdate` |
| `packages/adapters/src/computer-lifecycle.ts` | terminal/update read capabilities |
| each `*-sandbox.ts` `describe()` | set `inPlaceUpdate` (and `pty` where needed to keep UI) |
| `packages/core/src/attachments.ts` | `a2ui_surface` history line (Track B) |
| `packages/core/src/interaction-capability.ts` | `effectKind: string \| null` (Track B) |
| `packages/adapters/src/approval-ask.ts` | batch title uses inner actions (Track B) |

No new packages. No new `MessageBlock.kind`.

---

### Task 1: D3 — single builtin-name set and approval lists

**Files:**
- Modify: `packages/adapters/src/run-tool-selection.ts:47`
- Modify: `packages/core/src/action-approval.ts:33-51`
- Modify: `packages/core/src/action-approval.test.ts` (after the existing `respond_agent_connection` test ~950)
- Modify: `packages/adapters/src/index.test.ts` (builtin tools describe)
- Modify: `packages/adapters/src/builtin-tool-bridge.test.ts`
- Test: those same test files

**Interfaces:**
- Consumes: `builtinAgentTools`, `agentConnectionTools` from `packages/adapters/src/builtin-tools.ts`
- Produces: `BUILTIN_AGENT_TOOL_NAMES` contains every exported builtin name; `toolRequiresApproval("connect_agent", false) === true`; `isDeferredTool("connect_agent") === true`

- [ ] **Step 1: Write the failing tests**

In `packages/adapters/src/index.test.ts`, inside `describe("builtin tools")`, add:

```ts
it("puts every builtin, including agent-connection tools, in BUILTIN_AGENT_TOOL_NAMES", async () => {
  const { BUILTIN_AGENT_TOOL_NAMES } = await import("./run-tool-selection.js");
  for (const name of [...builtinAgentTools, ...agentConnectionTools].map((tool) => tool.name)) {
    expect(BUILTIN_AGENT_TOOL_NAMES.has(name), name).toBe(true);
  }
});
```

In `packages/core/src/action-approval.test.ts`, next to the existing `respond_agent_connection` test:

```ts
it("requires approval for cross-owner connect and message even as builtins", () => {
  expect(toolRequiresApproval("connect_agent", false)).toBe(true);
  expect(toolRequiresApproval("message_agent", false)).toBe(true);
  expect(toolRequiresExplicitApproval("respond_agent_connection")).toBe(true);
});
```

In `packages/adapters/src/builtin-tool-bridge.test.ts`:

```ts
import { agentConnectionTools } from "./builtin-tools.js";
import { CORE_BUILTIN_TOOL_NAMES, partitionTools } from "./builtin-tool-bridge.js";

it("defers agent-connection tools instead of listing their schemas", () => {
  const { listed, deferred } = partitionTools(agentConnectionTools);
  expect(deferred.map((tool) => tool.name).sort()).toEqual([
    "connect_agent",
    "message_agent",
    "respond_agent_connection",
  ]);
  expect(listed.map((tool) => tool.name).sort()).toEqual(["find_tool", "use_tool"]);
  for (const name of ["connect_agent", "message_agent", "respond_agent_connection"]) {
    expect(CORE_BUILTIN_TOOL_NAMES.has(name)).toBe(false);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/adapters/src/index.test.ts packages/core/src/action-approval.test.ts packages/adapters/src/builtin-tool-bridge.test.ts`

Expected: FAIL — `connect_agent` missing from `BUILTIN_AGENT_TOOL_NAMES`; `toolRequiresApproval("connect_agent", false)` is `false`; `partitionTools(agentConnectionTools)` lists the three tools with full schemas (no `find_tool`).

- [ ] **Step 3: Implement the minimal fix**

`packages/adapters/src/run-tool-selection.ts` — import `agentConnectionTools` and replace the set:

```ts
import { agentConnectionTools, builtinAgentTools } from "./builtin-tools.js";

export const BUILTIN_AGENT_TOOL_NAMES = new Set(
  [...builtinAgentTools, ...agentConnectionTools].map((tool) => tool.name),
);
```

`packages/core/src/action-approval.ts` — add to `APPROVAL_REQUIRED_BUILTIN_TOOLS` (keep `respond_agent_connection` in `EXPLICIT_APPROVAL_BUILTIN_TOOLS`):

```ts
  "connect_agent",
  "message_agent",
```

Do not add the three names to `CORE_BUILTIN_TOOL_NAMES`. Do not land the name-set change without the approval-list change in the same commit.

- [ ] **Step 4: Run tests to verify they pass**

Run the same vitest command as Step 2.

Expected: PASS. Also confirm `toolRequiresApproval("respond_agent_connection", false)` still true.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/run-tool-selection.ts packages/core/src/action-approval.ts packages/core/src/action-approval.test.ts packages/adapters/src/index.test.ts packages/adapters/src/builtin-tool-bridge.test.ts
git commit -m "$(cat <<'EOF'
Fix builtin agent-connection tools so the gate classifies them as builtins.

They lived in a second array, so they skipped find_tool and the approval lists. Classify and require approval together so connect/message cannot auto-run.
EOF
)"
```

---

### Task 2: D4 — `find_tool` name-index budget

**Files:**
- Modify: `packages/adapters/src/lazy-tool-catalog.ts` (export `sourceSummaryText`)
- Modify: `packages/adapters/src/builtin-tool-bridge.ts:106-120`
- Test: `packages/adapters/src/builtin-tool-bridge.test.ts`

**Interfaces:**
- Consumes: `fitsNameIndexBudget`, `formatNameIndexText`, `groupedNames` (already imported); `sourceSummaryText` after export
- Produces: `find_tool.description` uses `sourceSummaryText` when the deferred name index exceeds 200 names or 2048 bytes

- [ ] **Step 1: Write the failing test**

In `packages/adapters/src/builtin-tool-bridge.test.ts`:

```ts
import { NAME_INDEX_MAX_BYTES } from "./lazy-tool-catalog.js";

it("drops the inline name index when deferred tools overflow the catalog budget", () => {
  const deferred = Array.from({ length: 80 }, (_, i) => ({
    name: `scratchpad_extra_${String(i).padStart(3, "0")}_tool`,
    description: "x",
    inputSchema: { type: "object", properties: {} },
  }));
  const { listed } = partitionTools(deferred);
  const description = listed.find((tool) => tool.name === FIND_TOOL)!.description;
  expect(Buffer.byteLength(description, "utf8")).toBeLessThan(
    400 + NAME_INDEX_MAX_BYTES + 200,
  );
  expect(description).toMatch(/Sources:/);
  expect(description).not.toContain("scratchpad_extra_000_tool");
});
```

Adjust the fixture until the *current* (unfixed) `find_tool` description still contains `scratchpad_extra_000_tool` so the test fails for the right reason. 80 long names in one `scratchpad` group should exceed 2048 bytes.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/adapters/src/builtin-tool-bridge.test.ts`

Expected: FAIL — description still contains `scratchpad_extra_000_tool` (full index inlined).

- [ ] **Step 3: Implement**

Export `sourceSummaryText` from `packages/adapters/src/lazy-tool-catalog.ts` (change `function sourceSummaryText` to `export function sourceSummaryText`).

In `packages/adapters/src/builtin-tool-bridge.ts` `bridgeTools`:

```ts
import {
  catalogEntries,
  formatNameIndexText,
  groupedNames,
  fitsNameIndexBudget,
  sourceSummaryText,
} from "./lazy-tool-catalog.js";

function bridgeTools(deferred: readonly ConnectorTool[]): ConnectorTool[] {
  const grouped = groupedNames(searchEntries(deferred));
  const indexText = fitsNameIndexBudget(grouped)
    ? formatNameIndexText(grouped)
    : sourceSummaryText(grouped);
  return [
    {
      name: FIND_TOOL,
      description: `Get the parameters of built-in tools not in your tool list, including ones your instructions name. Call this before use_tool. Pass names for exact tools or query to search.\n${indexText}`,
      inputSchema: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, maxItems: 5 },
          query: { type: "string", maxLength: 200, description: "Words describing the task" },
        },
      },
      readOnly: true,
    },
    // existing use_tool entry unchanged
```

Keep the existing owner-chat test that every deferred name appears in `find_tool` — that run is under budget.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/adapters/src/builtin-tool-bridge.test.ts packages/adapters/src/lazy-tool-catalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/lazy-tool-catalog.ts packages/adapters/src/builtin-tool-bridge.ts packages/adapters/src/builtin-tool-bridge.test.ts
git commit -m "$(cat <<'EOF'
Cap find_tool's deferred name index with the same budget as connector catalogs.

Unbounded inlining made every new builtin grow every turn's prompt.
EOF
)"
```

---

### Task 3: D2 — Composio `readOnly` when the payload declares it

**Files:**
- Modify: `packages/adapters/src/composio-connector.ts:62-88` (`mapOneTool`)
- Test: `packages/adapters/src/composio-connector.test.ts` (`describe("composio tool mapping")`)
- Test: `packages/core/src/action-approval.test.ts` already covers `toolRequiresApproval(name, true, true|false)` — do not change gate heuristics

**Interfaces:**
- Consumes: Composio session tool objects (`function` or slug records)
- Produces: `ConnectorTool.readOnly` set only when the payload has an explicit boolean (`readOnly`, `read_only`, or `annotations.readOnlyHint`). Otherwise omit the field so the name heuristic still applies.

- [ ] **Step 1: Write the failing test**

In `packages/adapters/src/composio-connector.test.ts` inside `describe("composio tool mapping")`:

```ts
it("copies explicit readOnly metadata and leaves unmarked tools without the flag", () => {
  const tools = asConnectorTools([
    {
      slug: "GMAIL_GET_PROFILE",
      description: "Profile",
      readOnly: true,
    },
    {
      type: "function",
      function: {
        name: "GMAIL_SEND_EMAIL",
        description: "Send",
        annotations: { readOnlyHint: false },
      },
    },
    { slug: "HACKERNEWS_GET_USER", description: "HN" },
  ]);
  expect(tools[0]?.readOnly).toBe(true);
  expect(tools[1]?.readOnly).toBe(false);
  expect(tools[2]?.readOnly).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/adapters/src/composio-connector.test.ts`

Expected: FAIL — `readOnly` undefined on all three.

- [ ] **Step 3: Implement**

In `mapOneTool`, add a helper in the same file:

```ts
function declaredReadOnly(raw: Record<string, unknown>): boolean | undefined {
  if (typeof raw.readOnly === "boolean") return raw.readOnly;
  if (typeof raw.read_only === "boolean") return raw.read_only;
  const annotations = raw.annotations;
  if (annotations && typeof annotations === "object" && !Array.isArray(annotations)) {
    const hint = (annotations as Record<string, unknown>).readOnlyHint;
    if (typeof hint === "boolean") return hint;
  }
  return undefined;
}
```

Spread onto both return shapes:

```ts
const readOnly = declaredReadOnly(fn) ?? declaredReadOnly(raw);
return {
  name,
  description: ...,
  inputSchema: ...,
  batch: ...,
  route: ...,
  ...(readOnly === undefined ? {} : { readOnly }),
};
```

For the OpenAI-style branch, pass `fn` into `declaredReadOnly` first, then `raw`. Do not infer from the tool name here.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/adapters/src/composio-connector.test.ts packages/core/src/action-approval.test.ts`

Expected: PASS. `gmail_send_email` with no flag still requires approval via the name heuristic.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/composio-connector.ts packages/adapters/src/composio-connector.test.ts
git commit -m "$(cat <<'EOF'
Honor Composio readOnly metadata when the provider actually sends it.

The gate already prefers declared effect; mapping never emitted the field.
EOF
)"
```

---

### Task 4: D8 — unavailable placeholders when a connection exists but listing fails

**Files:**
- Modify: `packages/adapters/src/composio-connector.ts` (`discoverTools` ~534, `execute`)
- Modify: `packages/adapters/src/pipedream-connector.ts` (`allTools` catch blocks ~193-211, `execute`)
- Test: `packages/adapters/src/composio-connector.test.ts`
- Test: `packages/adapters/src/pipedream-connector.ts` existing test file if present, else add cases next to discovery tests

**Interfaces:**
- Consumes: `context` connections; MCP `unavailableTool` as the pattern (`packages/adapters/src/mcp-connector.ts:265-279`)
- Produces: `composio__unavailable` when Composio connections exist but session/tools cannot be listed; `pipedream__<app>__unavailable` when that app has accounts but listing throws. Zero connections still `[]`. Placeholder `readOnly: true`; execute yields the same message.

- [ ] **Step 1: Write the failing tests**

Composio (use the existing session mock in `composio-connector.test.ts`):

```ts
it("returns no tools when the user never connected composio", async () => {
  const connector = new ComposioConnector(/* existing test construction */);
  const tools = await connector.discoverTools({
    ...contextWithNoConnections,
  });
  expect(tools).toEqual([]);
});

it("offers a read-only unavailable tool when connections exist but listing fails", async () => {
  // context.connectedConnections has a composio row; session.tools throws or session is missing
  const tools = await connector.discoverTools(contextWithDeadConnection);
  expect(tools).toEqual([
    expect.objectContaining({
      name: "composio__unavailable",
      readOnly: true,
    }),
  ]);
});
```

Wire these to the file's existing `ComposioConnector` + context fixtures (copy `userId` / `connectedConnections` from nearby tests). Do not invent a second constructor.

Pipedream: in the discovery-failure path, expect `pipedream__gmail__unavailable` (or whatever `externalId` the fixture uses) instead of swallowing to `[]`, and still expect other apps' tools to remain.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/adapters/src/composio-connector.test.ts packages/adapters/src/pipedream-connector.test.ts`

Expected: FAIL — dead connection still returns `[]`.

- [ ] **Step 3: Implement**

Shared shape (keep in each file to avoid a new package; copy MCP wording):

```ts
const UNAVAILABLE_TOOL = "unavailable";

function composioUnavailableTool(reason: string): ConnectorTool {
  const brief = reason.length > 400 ? `${reason.slice(0, 400)}...` : reason;
  return {
    name: "composio__unavailable",
    description: `Connected apps are assigned but unavailable right now, so none of their tools can be used. Reason: ${brief}. Tell the user to reconnect rather than using shell to write a client. Calling this tool returns the same error.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    route: { connectorId: "composio", toolName: UNAVAILABLE_TOOL },
  };
}
```

`discoverTools`: if `connectedComposioConnections(context).length === 0` return `[]`. If session is missing or `session.tools()` throws / cannot be converted, return `[composioUnavailableTool(message)]`.

In `execute`, if `call.route?.toolName === UNAVAILABLE_TOOL` or `call.tool === "composio__unavailable"`, yield `{ type: "error", message: <same reason> }` and return.

Pipedream `allTools`: on per-app or per-account catch, `return [pipedreamUnavailableTool(app, message)]` instead of `[]`. Other apps still flatten as today.

Do not emit a placeholder when `apps.length === 0`.

- [ ] **Step 4: Run tests**

Run the same vitest command as Step 2 plus any MCP connector test file to ensure the original placeholder still works.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/composio-connector.ts packages/adapters/src/composio-connector.test.ts packages/adapters/src/pipedream-connector.ts packages/adapters/src/pipedream-connector.test.ts
git commit -m "$(cat <<'EOF'
Show an unavailable placeholder when a connected app cannot list tools.

Empty catalogs after revoke made the model fall back to shell clients.
EOF
)"
```

---

### Task 5: D6 — terminal/update from `describe().capabilities`

**Files:**
- Modify: `packages/adapter-kit/src/types.ts:269-277`
- Modify: `packages/adapters/src/computer-lifecycle.ts:972-988`
- Modify: every sandbox `describe().capabilities` listed in the file map (add `inPlaceUpdate`)
- Modify: `packages/adapters/src/desktop-sandbox.ts` — set `pty: false` so Settings terminal stays off (host shell is not the Linux screen gateway). Comment why.
- Modify: `packages/adapters/src/wuying-sandbox.ts` `describeWuyingSandbox` — `inPlaceUpdate: false`
- Test: `packages/adapters/src/computer-lifecycle.test.ts` (~2784 and ~4013)

**Interfaces:**
- Consumes: `SandboxCapabilities`
- Produces: `computerSupportsTerminal(kind)` ≡ `sandboxCapabilitiesForKind(kind).pty`; `computerSupportsUpdate(kind)` ≡ `sandboxCapabilitiesForKind(kind).inPlaceUpdate === true`. Public function signatures stay `(kind: string) => boolean` so `apps/api/src/computer-status.ts` does not change.

- [ ] **Step 1: Write tests that pin today's booleans, then require capabilities as the source**

Keep the existing expectations:

```
computerSupportsUpdate("e2b") true
computerSupportsUpdate("desktop"|"wuying"|"none") false
computerSupportsTerminal("novita") true
computerSupportsTerminal("unknown"|"none") false
```

Add:

```ts
import { describeDesktopSandbox } from "./desktop-sandbox.js";
import { describeWuyingSandbox } from "./wuying-sandbox.js";

it("reads terminal and update from describe() capabilities, not a parallel kind list", () => {
  expect(describeWuyingSandbox().capabilities.pty).toBe(false);
  expect(describeWuyingSandbox().capabilities.inPlaceUpdate).toBe(false);
  expect(computerSupportsTerminal("wuying")).toBe(describeWuyingSandbox().capabilities.pty);
  expect(computerSupportsUpdate("wuying")).toBe(
    describeWuyingSandbox().capabilities.inPlaceUpdate === true,
  );
  expect(computerSupportsTerminal("desktop")).toBe(describeDesktopSandbox().capabilities.pty);
  expect(computerSupportsUpdate("desktop")).toBe(
    describeDesktopSandbox().capabilities.inPlaceUpdate === true,
  );
});
```

Until `inPlaceUpdate` exists, TypeScript fails at compile; the test file is the first consumer.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/adapters/src/computer-lifecycle.test.ts`

Expected: FAIL/TS error — `inPlaceUpdate` does not exist.

- [ ] **Step 3: Implement**

`packages/adapter-kit/src/types.ts`:

```ts
export interface SandboxCapabilities {
  graphical: boolean;
  pty: boolean;
  snapshots: boolean;
  takeover: boolean;
  persistentHome: boolean;
  multiScreen?: boolean;
  /** In-place image/template upgrade. False for desktop, wuying, and none. */
  inPlaceUpdate?: boolean;
}
```

Add `sandboxCapabilitiesForKind(kind: string): SandboxCapabilities` in `computer-lifecycle.ts`. Implement it as a switch that returns the **same** capability object each provider's `describe()` already returns (import `describeWuyingSandbox`, `describeDesktopSandbox`; for class providers, duplicate the boolean fields in the switch so computer-lifecycle does not import every SDK). Then:

```ts
export function computerSupportsUpdate(kind: string): boolean {
  return sandboxCapabilitiesForKind(kind).inPlaceUpdate === true;
}

export function computerSupportsTerminal(kind: string): boolean {
  return sandboxCapabilitiesForKind(kind).pty === true;
}

function sandboxCapabilitiesForKind(kind: string): SandboxCapabilities {
  switch (kind) {
    case "docker":
    case "e2b":
    case "novita":
    case "daytona":
    case "boat":
    case "kubernetes":
    case "incus":
    case "fake":
      return {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        inPlaceUpdate: true,
      };
    case "desktop":
      return describeDesktopSandbox().capabilities;
    case "wuying":
      return describeWuyingSandbox().capabilities;
    default:
      return {
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: false,
        inPlaceUpdate: false,
      };
  }
}
```

Set `inPlaceUpdate` on every `describe()`: `false` for desktop, wuying, none; `true` otherwise (including railway/createos/boxd so `computerSupportsUpdate` stays true for those kinds). Set `describeDesktopSandbox().capabilities.pty` to `false` and comment: Settings terminal is the Linux screen gateway; this host is not on that list.

Do not add `accessibilityTree` / `visionGrounding` / `recipeRuntime`. Leave `snapshot()` throws in place.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/adapters/src/computer-lifecycle.test.ts packages/adapters/src/sandbox-factory.test.ts`

Expected: PASS. Existing update/terminal expectations unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-kit/src/types.ts packages/adapters/src/computer-lifecycle.ts packages/adapters/src/computer-lifecycle.test.ts packages/adapters/src/*-sandbox.ts
git commit -m "$(cat <<'EOF'
Drive computer terminal and update flags from sandbox capabilities.

Kind string allowlists drifted from describe() and failed only at runtime.
EOF
)"
```

---

**Track A ends here.** Stop if Track B is not approved.

---

### Task 6: D1 — `a2ui_surface` in model history (Track B, needs approval)

**Files:**
- Modify: `packages/core/src/attachments.ts:167-208`
- Test: `packages/core/src/attachments.test.ts`

**Interfaces:**
- Consumes: `MessageBlock` kind `a2ui_surface` (`packages/contracts/src/interaction.ts:98-133`) fields `intent?`, `lifecycle?`, `title?`, `summary?`
- Produces: `blocksToAgentHistoryText` never returns `""` for an `a2ui_surface` block

- [ ] **Step 1: Write the failing test**

In `packages/core/src/attachments.test.ts`:

```ts
describe("a2ui surface history", () => {
  it("projects intent and lifecycle so a later turn can see the card", () => {
    expect(
      blocksToAgentHistoryText([
        {
          kind: "a2ui_surface",
          interactionId: "ix-1",
          surfaceId: "s-1",
          protocolFamily: "a2ui",
          draftVersion: 1,
          intent: "email.compose",
          lifecycle: "sent",
          summary: "to: a@b.com",
        },
      ]),
    ).toBe("[card: email.compose → sent (to: a@b.com)]");
  });

  it("never drops a legacy surface with no title or summary", () => {
    expect(
      blocksToAgentHistoryText([
        {
          kind: "a2ui_surface",
          interactionId: "ix-1",
          surfaceId: "s-1",
          protocolFamily: "a2ui",
          draftVersion: 1,
        },
      ]),
    ).toBe("[card: a2ui_surface → draft]");
  });
});
```

Use whatever `protocolFamily` union the contract requires if `"a2ui"` does not typecheck (read `A2uiProtocolFamily` in `packages/contracts/src/interaction.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/attachments.test.ts`

Expected: FAIL — both cases currently compile to `""` and are filtered out, so the joined string is `""`.

- [ ] **Step 3: Implement**

In `blocksToAgentHistoryText`, before the `"text" in block` fallback:

```ts
if (block.kind === "a2ui_surface") {
  const intent = block.intent?.trim() || "a2ui_surface";
  const state = block.lifecycle ?? "draft";
  const hint = (block.summary ?? block.title)?.trim();
  return hint ? `[card: ${intent} → ${state} (${hint})]` : `[card: ${intent} → ${state}]`;
}
```

Do not put body/to/full fields in the line beyond `summary`/`title`. Do not change `message-quote.ts`.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/core/src/attachments.test.ts packages/core/src/message-quote.test.ts packages/core/src/call-request.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/attachments.ts packages/core/src/attachments.test.ts
git commit -m "$(cat <<'EOF'
Project A2UI surfaces into agent history as a compact status line.

Cards contributed nothing, so the model could not see send or field edits.
EOF
)"
```

---

### Task 7: Widen `effectKind` and prove a third-domain schema compiles (Track B, needs approval)

**Files:**
- Modify: `packages/core/src/interaction-capability.ts:29`
- Test: `packages/core/src/interaction-capability.test.ts`
- Test: `packages/a2ui-adapter/src/compile-surface.test.ts`
- Do **not** add a production intent. Do **not** change `executeConfirmedInteractionService` in this task (spec §6.1 steps 3–4 wait for a real future intent).

**Interfaces:**
- Consumes: `InteractionCapability.effectKind`
- Produces: type `string | null`; `interactionIntents()` remains the four product intents; `compileInteractionSurface` accepts a non-email/non-calendar schema with action `save`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/interaction-capability.test.ts` — tighten the prompt list:

```ts
it("exposes exactly the four product intents", () => {
  expect(interactionIntents().sort()).toEqual(
    ["calendar.create", "calendar.query", "email.compose", "interaction.result"].sort(),
  );
});
```

`packages/a2ui-adapter/src/compile-surface.test.ts`:

```ts
it("compiles a third-domain form without email templates", async () => {
  const schema: InteractionSurfaceSchema = {
    schemaVersion: 1,
    presentation: "form",
    fields: [{ name: "note", label: "Note", kind: "text", required: true, maxLength: 80 }],
    action: { id: "save", label: "Save", requiresRevision: true },
  };
  const result = await compileInteractionSurface({
    schema,
    values: { note: "hello" },
    surfaceId: "s-test",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const components = componentsOf(result.messages);
  expect(components.some((component) => component.component === "TextField")).toBe(true);
  expect(JSON.stringify(result.messages)).not.toMatch(/email-draft-card|email.compose/);
});
```

Also add a history test in `attachments.test.ts` using `intent: "test.form"` (not registered) to prove the history helper keys off the block, not the email template module.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run packages/core/src/interaction-capability.test.ts packages/a2ui-adapter/src/compile-surface.test.ts packages/core/src/attachments.test.ts`

Expected: the exact-four-intents test may already pass; `effectKind` is still a two-value union until Step 3. The compile test should already pass if the compiler is generic — if it passes immediately, keep it as a regression pin. The type change is still required.

- [ ] **Step 3: Implement the type change**

`packages/core/src/interaction-capability.ts`:

```ts
  /** ExternalEffect kind the action creates, or null for a read-only surface. */
  effectKind: string | null;
```

Do not add `test.form` to `INTERACTION_CAPABILITIES`. Do not import email templates into `compile-surface.ts`.

Fix any compile errors from the union widening (switch statements that exhaust `"email.send" | "calendar.create"`). Prefer reading `capability.effectKind` over adding new `if (intent === ...)` branches. Leave `interactionEffectKind()` behavior for email vs `interaction.confirm` as-is unless TypeScript forces a touch; if you touch it, keep the same runtime mapping.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/core/src/interaction-capability.test.ts packages/a2ui-adapter/src/compile-surface.test.ts packages/core/src/interaction-effect.test.ts packages/core/src/attachments.test.ts`

Expected: PASS. `findInteractionCapability("test.form")` is still `undefined`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/interaction-capability.ts packages/core/src/interaction-capability.test.ts packages/a2ui-adapter/src/compile-surface.test.ts packages/core/src/attachments.test.ts
git commit -m "$(cat <<'EOF'
Allow interaction effectKind to be any registered string.

The two-value union made every new form a framework change; product intents stay four.
EOF
)"
```

---

### Task 8: D5 — ask cards name inner batch actions (Track B, needs approval)

**Files:**
- Modify: `packages/adapters/src/approval-ask.ts:170-176` and `describeApprovalAction`
- Test: `packages/adapters/src/approval-ask.test.ts`

**Interfaces:**
- Consumes: `ToolBatch` `{ items, action, arguments }` and `batchActions` (already imported)
- Produces: `buildApprovalAskBlock` title `Review before GMAIL_DELETE_EVENT, GMAIL_DELETE_EVENT` (inner slugs) instead of `Review before COMPOSIO_MULTI_EXECUTE_TOOL` when `options.batch` is set. Pending settlement remains `answerRunInput` in `packages/db/src/events.ts` (already sets `status: "answered"`); add a test only if a regression is found — do not reimplement settlement.

- [ ] **Step 1: Write the failing test**

```ts
it("titles a batch review with the inner actions, not the wrapper tool name", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "COMPOSIO_MULTI_EXECUTE_TOOL",
    {
      tools: [
        { tool_slug: "GMAIL_DELETE_EVENT", arguments: { event_id: "1" } },
        { tool_slug: "GMAIL_DELETE_EVENT", arguments: { event_id: "2" } },
      ],
    },
    [],
    {
      batch: { items: "tools", action: "tool_slug", arguments: "arguments" },
    },
  );
  expect(block.kind).toBe("ask");
  if (block.kind !== "ask") throw new Error("expected ask");
  expect(block.text).toBe("Review before GMAIL_DELETE_EVENT, GMAIL_DELETE_EVENT");
  expect(block.text).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
  expect(block.status).toBe("pending");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/adapters/src/approval-ask.test.ts`

Expected: FAIL — text is `Review before COMPOSIO_MULTI_EXECUTE_TOOL`.

- [ ] **Step 3: Implement**

`describeApprovalAction` already joins `batch.actions`. Use that string as `summary` in `buildApprovalAskBlock` for the default branch (the `Review before ${summary}` path). Today `summary` is the outer `toolName` unless a fleet card is passed. Thread `options?.batch` into the summary:

```ts
const summary = describeApprovalAction(toolName, args, options?.batch);
```

at the point the default ask block builds `text`, instead of using `toolName` alone. Keep `create_space` and fleet `options.summary` branches unchanged.

Do not emit one ask block per inner action in this task (gate already decides per action). One card listing inner names is the spec's "一条卡内逐项".

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/adapters/src/approval-ask.test.ts`

Expected: PASS. Existing gmail_send_email title tests still match.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/approval-ask.ts packages/adapters/src/approval-ask.test.ts
git commit -m "$(cat <<'EOF'
Name batch approval cards after the inner actions they will run.

The wrapper tool name made six deletes look like one opaque COMPOSIO call.
EOF
)"
```

---

## Self-review (plan vs spec)

| Spec item | Task |
|---|---|
| D3 single name set + approval | Task 1 |
| D4 find_tool budget | Task 2 |
| D2 readOnly metadata | Task 3 |
| D8 unavailable placeholder | Task 4 |
| D6 capabilities / inPlaceUpdate | Task 5 |
| D7 no rename | Global constraint (no task) |
| D9 no plugin code exec | Global constraint |
| D1 history | Task 6 |
| effectKind string, four product intents, fake compile | Task 7 |
| D5 ask copy, no new intents | Task 8 |
| §6.1 eight steps for later intents | Spec only; Task 7 explicitly skips execute adapter |
| Uninstalled marketplace discovery | Out of scope |
| SimuLang / tool-tiers.md | Out of scope |

No TBD placeholders. `sandboxCapabilitiesForKind` is defined in Task 5. Placeholder tool names `composio__unavailable` / `pipedream__<app>__unavailable` are defined in Task 4. History format is defined in Task 6.
