import { describe, expect, it } from "vitest";
import {
  classifyToolCall,
  describeRoute,
  INTERACTION_LAYERS,
  isDiscoveryTool,
  routeAppRequest,
  routeDidExecute,
  routeIntentRequest,
  routeIsActionable,
  routeNeedsAuthorization,
  routeWebRequest,
} from "./interaction-route.js";

/**
 * The five layers, and the three claims that must never be made.
 *
 * A page opening is not an authorization. A catalog entry is not something that can run. A tool
 * search is not a tool call. Each of these was reported as the stronger thing at some point, and
 * each is a single predicate here, so a caller cannot quietly conflate them.
 */

const connectedGmail = [{ provider: "gmail", status: "connected" }];
const noConnections: Array<{ provider: string; status: string }> = [];

describe("opening a page is not connecting an app", () => {
  it("reports web entry with no connection and no action", () => {
    const route = routeWebRequest({ url: "https://docs.google.com/document/u/0/" });
    expect(route).toMatchObject({ layer: "web", kind: "web", connected: false, executable: false });
    // The two predicates a caller is most likely to reach for both say no.
    expect(routeDidExecute(route)).toBe(false);
    expect(routeNeedsAuthorization(route)).toBe(false);
    expect(routeIsActionable(route)).toBe(false);
  });

  it("says it opened a page, not that anything is connected", () => {
    const text = describeRoute(routeWebRequest({ url: "https://notion.so" }));
    expect(text).toContain("page");
    expect(text).toContain("No app was connected");
    // It must not claim the app is usable or that work happened.
    expect(text).not.toMatch(/was connected\b.*app|has been executed/i);
  });
});

describe("a catalog entry is not an executable capability", () => {
  it("stops at the connection layer when the app is not authorized, even though the app exists", () => {
    const route = routeAppRequest({
      app: "email",
      provider: "gmail",
      connections: noConnections,
    });
    expect(route).toMatchObject({ layer: "connection", kind: "needs_connection", app: "email" });
    expect(routeNeedsAuthorization(route)).toBe(true);
    // Showing that Gmail exists never makes it runnable.
    expect(routeDidExecute(route)).toBe(false);
    expect(routeIsActionable(route)).toBe(false);
  });

  it("does not claim execution for a connected app either", () => {
    const route = routeAppRequest({
      app: "email",
      provider: "gmail",
      label: "Gmail",
      connections: connectedGmail,
    });
    // A live connection is L3 satisfied, not L2: `catalog` is the layer for an app merely shown,
    // and putting a connected app below an unconnected one would invert the layer order.
    expect(route).toMatchObject({ layer: "connection", kind: "connected", connected: true });
    expect(routeDidExecute(route)).toBe(false);
    expect(routeIsActionable(route)).toBe(false);
  });
});

describe("a registered capability becomes a draft, not a result", () => {
  it("renders an editable card for a connected app and is not executed by being shown", () => {
    const route = routeIntentRequest({ intent: "email.compose", connections: connectedGmail });
    expect(route).toMatchObject({ layer: "card", kind: "draft", intent: "email.compose" });
    expect(routeIsActionable(route)).toBe(true);
    // A draft that was merely displayed has not run.
    expect(routeDidExecute(route)).toBe(false);
  });

  it("requires the connection before offering the card", () => {
    const route = routeIntentRequest({ intent: "email.compose", connections: noConnections });
    expect(route).toMatchObject({ layer: "connection", kind: "needs_connection", app: "email" });
    expect(routeIsActionable(route)).toBe(false);
  });

  it("does not invent a card for an intent nothing registered", () => {
    const route = routeIntentRequest({ intent: "note.compose", connections: noConnections });
    expect(route.kind).toBe("catalog");
    expect(routeIsActionable(route)).toBe(false);
    expect(routeDidExecute(route)).toBe(false);
  });
});

describe("a tool search is not a tool call", () => {
  it("treats the provider's search tool as discovery", () => {
    expect(isDiscoveryTool("COMPOSIO_SEARCH_TOOLS")).toBe(true);
    const route = classifyToolCall({ tool: "COMPOSIO_SEARCH_TOOLS" });
    expect(route).toMatchObject({ kind: "discovered", executed: false, effectId: null });
    expect(routeDidExecute(route)).toBe(false);
  });

  it("treats a schema load and the built-in find_tool as discovery too", () => {
    // A schema lookup is the result a model is most likely to read as "ready to run", so every
    // wrapper that returns one has to say it discovered rather than executed.
    for (const tool of ["connectors_search_tools", "connectors_load_tool", "find_tool"]) {
      const route = classifyToolCall({ tool, effectId: "effect-1" });
      expect(route, tool).toMatchObject({ kind: "discovered", executed: false, effectId: null });
    }
    // A tool that merely loads its own data is still an ordinary action.
    expect(isDiscoveryTool("GMAIL_LOAD_MESSAGE")).toBe(false);
  });

  it("does not treat a real action merely named after search as discovery", () => {
    // The catalog-search meta-tool is the only thing that returns schemas. A provider action
    // that happens to contain the word "search" is a real call — some read, some write — and
    // denying it an effect row would be the opposite of what this predicate is for. This is the
    // regression that a `SEARCH` substring match caused.
    for (const tool of [
      "GOOGLE_SEARCH_CONSOLE_SUBMIT_SITEMAP",
      "SLACK_SEARCH_MESSAGES",
      "GMAIL_SEARCH_EMAILS",
      "NOTION_SEARCH",
    ]) {
      expect(isDiscoveryTool(tool), tool).toBe(false);
      // With a ledger row it is an execution; without one it is only discovered.
      expect(classifyToolCall({ tool, effectId: "effect-1" }).kind, tool).toBe("executed");
    }
  });

  it("recognises the meta-search under the spellings it actually has", () => {
    // Only the documented shape: the connector's catalog-search tool, whose name ends in
    // SEARCH_TOOL or SEARCH_TOOLS. Other spellings are deliberately not guessed at — see the
    // module comment for why an over-broad match is the worse failure.
    for (const tool of ["COMPOSIO_SEARCH_TOOLS", "composio_search_tools", "SEARCH_TOOL"]) {
      expect(isDiscoveryTool(tool), tool).toBe(true);
    }
  });

  it("refuses to call a search executed even when an id is supplied", () => {
    // A caller that mislabels a search must not be able to talk this into an execution claim.
    const route = classifyToolCall({
      tool: "COMPOSIO_SEARCH_TOOLS",
      effectId: "effect-1",
    });
    expect(route).toMatchObject({ kind: "discovered", executed: false, effectId: null });
    expect(routeDidExecute(route)).toBe(false);
  });

  it("only calls a real tool call executed when there is a ledger row", () => {
    const executed = classifyToolCall({ tool: "GMAIL_SEND_EMAIL", effectId: "effect-9" });
    expect(executed).toMatchObject({ kind: "executed", executed: true, effectId: "effect-9" });
    expect(routeDidExecute(executed)).toBe(true);
  });

  it("reports a non-search call with no ledger row as discovered, not executed", () => {
    // The effect row is the receipt. Without one, nothing can be said to have happened — this is
    // the case that would otherwise let "the tool returned" stand in for "the work is done".
    for (const effectId of [undefined, null, "  "]) {
      const route = classifyToolCall({ tool: "GMAIL_SEND_EMAIL", effectId });
      expect(route.kind, String(effectId)).toBe("discovered");
      expect(routeDidExecute(route)).toBe(false);
    }
  });

  it("says only that a tool was found when it was only found", () => {
    const text = describeRoute(classifyToolCall({ tool: "COMPOSIO_SEARCH_TOOLS" }));
    expect(text).toContain("has not been executed");
    expect(text).not.toMatch(/has been executed/i);
  });
});

describe("the layers keep their order", () => {
  it("lists each layer once, from entry to card", () => {
    expect(INTERACTION_LAYERS).toEqual(["web", "catalog", "connection", "tool", "card"]);
  });

  it("never reports execution, authorization and actionability together by accident", () => {
    // Only an executed tool call is "did something"; none of the others are, and a draft is
    // actionable without having run.
    const routes = [
      routeWebRequest({ url: "https://example.test" }),
      routeAppRequest({ app: "email", provider: "gmail", connections: noConnections }),
      routeAppRequest({ app: "email", provider: "gmail", connections: connectedGmail }),
      classifyToolCall({ tool: "COMPOSIO_SEARCH_TOOLS" }),
      classifyToolCall({ tool: "GMAIL_SEND_EMAIL", effectId: "effect-1" }),
      routeIntentRequest({ intent: "email.compose", connections: connectedGmail }),
    ];
    const executed = routes.filter(routeDidExecute).map((route) => route.kind);
    expect(executed).toEqual(["executed"]);
    const actionable = routes.filter(routeIsActionable).map((route) => route.kind);
    // A draft is the only actionable route, and it is not an executed one.
    expect(actionable).toEqual(["draft"]);
  });
});
