import type { InteractionCapability } from "./interaction-capability.js";
import { findInteractionCapability } from "./interaction-capability.js";
import type { InteractionRequiredApp } from "./interaction-connection.js";
import { connectionSatisfiesApp, interactionRequiredApp } from "./interaction-connection.js";

/**
 * What a natural-language request actually resolved to, layer by layer.
 *
 * The audit behind this code found one mistake repeated in several shapes: a page opening was
 * reported as an app being authorized, a catalog entry as a capability that could run, and a
 * successful tool search as work already done. Each of those is a different *layer*, and the
 * layers have an order. This module names them once so no surface, route or tool has to
 * re-derive the distinction:
 *
 *   L1 web entry       open a URL in a browser. Changes nothing about authorization.
 *   L2 catalog         show that an app exists and can be connected. Still not executable.
 *   L3 connection      the person authorized the app. Still not something we have run.
 *   L4 discovery       a tool exists / was searched for. A search result proves nothing ran.
 *   L4 execution       a tool actually ran, and the effect ledger is the evidence.
 *   L5 card            a draft the person can edit, confirm and discard.
 *
 * The rule the whole module exists to keep: a later layer may only be claimed when its own
 * evidence is present. `page` never implies `connection`; `discovered` never implies `executed`.
 */

/** The ordered layers a request can reach. */
export const INTERACTION_LAYERS = ["web", "catalog", "connection", "tool", "card"] as const;

export type InteractionLayer = (typeof INTERACTION_LAYERS)[number];

/** Where a request stopped, and what it is waiting for before it can go further. */
export type LayerRoute =
  | {
      /** A URL is opened for the person. Not authorization, and not an app capability. */
      layer: "web";
      kind: "web";
      url: string;
      /** Always false: opening a page never establishes a connection. */
      connected: false;
      /** Always false: a page is not a registered capability with a button. */
      executable: false;
    }
  | {
      /** An app exists and could be connected. Displaying it is not running it. */
      layer: "catalog";
      kind: "catalog";
      app: string;
      /** True only when a connection already exists for this app. */
      connected: boolean;
      /** Always false: a catalog entry is never executable on its own. */
      executable: false;
    }
  | {
      /** The app is not authorized yet, so the next step is the person's own authorization. */
      layer: "connection";
      kind: "needs_connection";
      app: InteractionRequiredApp;
      provider: string;
      executable: false;
    }
  | {
      /** A tool was found but not run. The evidence of a search is not evidence of an effect. */
      layer: "tool";
      kind: "discovered";
      tool: string;
      /** Always false: discovery is not execution. */
      executed: false;
      /** Always false: nothing has run, so there is no effect to point at. */
      effectId: null;
    }
  | {
      /** A tool ran, and this names the effect row that is the receipt for it. */
      layer: "tool";
      kind: "executed";
      tool: string;
      executed: true;
      /** The effect ledger row. A call without one cannot claim to have happened. */
      effectId: string;
    }
  | {
      /** The request resolved to a registered capability, which becomes an editable card. */
      layer: "card";
      kind: "draft";
      intent: string;
      /** Whether the app it needs is connected, from the caller's own records. */
      connected: boolean;
      /** A card is confirmable, never executed by being shown. */
      executable: false;
    };

export type LayerRouteKind = LayerRoute["kind"];

/**
 * Whether a route has crossed the line from describing to doing.
 *
 * Only an `executed` route has. Everything else — a page, a catalog entry, a connection, a
 * discovered tool, a draft card — describes or prepares, and reporting any of them as work
 * completed is the defect this function is here to prevent.
 */
export function routeDidExecute(route: LayerRoute): boolean {
  return route.kind === "executed";
}

/**
 * Whether the route needs the person to authorize an app before it can continue.
 *
 * Authorization is its own layer: a page was opened for them, or a catalog entry was shown, and
 * neither is the same as them granting access.
 */
export function routeNeedsAuthorization(route: LayerRoute): boolean {
  return route.kind === "needs_connection";
}

/** Whether the route can be acted on by the person right now (a card they can confirm). */
export function routeIsActionable(route: LayerRoute): boolean {
  return route.kind === "draft" && route.connected;
}

/** A tool name the connector uses to search its own catalog rather than to act. */
const DISCOVERY_TOOL = /(^|_)SEARCH(_|$)/i;

/** Whether a tool call is a search. A search result is discovered, never executed. */
export function isDiscoveryTool(tool: string): boolean {
  return DISCOVERY_TOOL.test(tool);
}

/**
 * Classify a connector tool call into discovery or execution.
 *
 * The distinction is not cosmetic. `COMPOSIO_SEARCH_TOOLS` returning a schema means the provider
 * knows a tool exists; it does not mean anything was run, and an effect row is the only record
 * that something was. A search therefore always reports `effectId: null`, even if the caller
 * happens to have an id in hand.
 */
export function classifyToolCall(input: { tool: string; effectId?: string | null }): LayerRoute {
  if (isDiscoveryTool(input.tool)) {
    return { layer: "tool", kind: "discovered", tool: input.tool, executed: false, effectId: null };
  }
  const effectId = input.effectId?.trim();
  if (!effectId) {
    // No ledger row means we cannot say it ran. Saying otherwise is the claim this module
    // exists to refuse, so a call with no effect is reported as only discovered.
    return { layer: "tool", kind: "discovered", tool: input.tool, executed: false, effectId: null };
  }
  return { layer: "tool", kind: "executed", tool: input.tool, executed: true, effectId };
}

/** A connection the caller already holds, in provider-neutral terms. */
export type KnownConnection = {
  provider: string;
  status: string;
};

function appIsConnected(app: InteractionRequiredApp, connections: readonly KnownConnection[]) {
  return connections.some(
    (connection) =>
      connection.status === "connected" && connectionSatisfiesApp(app, connection.provider),
  );
}

/**
 * Route a request that arrived as an app name.
 *
 * The app is given directly rather than inferred from its provider slug: a provider names a
 * service ("gmail"), while an app names what the product can do with it ("email"). Mapping one to
 * the other is `connectionSatisfiesApp`'s job and is done below, not by guessing here.
 *
 * With no connection this stops at L3: the person has to authorize the app themselves. Showing
 * the catalog entry is never the answer to "do this for me", and it never claims the app is
 * usable.
 */
export function routeAppRequest(input: {
  app: InteractionRequiredApp;
  provider: string;
  /** A label for the app, used only in text. */
  label?: string;
  connections: readonly KnownConnection[];
}): LayerRoute {
  const connected = appIsConnected(input.app, input.connections);
  if (!connected) {
    return {
      layer: "connection",
      kind: "needs_connection",
      app: input.app,
      provider: input.provider,
      executable: false,
    };
  }
  return {
    layer: "catalog",
    kind: "catalog",
    app: input.label ?? input.app,
    connected: true,
    executable: false,
  };
}

/**
 * Route a request that named a registered capability.
 *
 * An unregistered intent has no card and no action; it is reported as a catalog-shaped dead end
 * rather than given a surface that cannot work.
 */
export function routeIntentRequest(input: {
  intent: string;
  connections: readonly KnownConnection[];
  capability?: InteractionCapability;
}): LayerRoute {
  const capability = input.capability ?? findInteractionCapability(input.intent);
  if (!capability || !capability.implemented) {
    // Not a registered capability: there is nothing to render and nothing to run. Saying so is
    // better than publishing a card whose button cannot work.
    return {
      layer: "catalog",
      kind: "catalog",
      app: input.intent,
      connected: false,
      executable: false,
    };
  }
  const app = interactionRequiredApp(capability.intent);
  const connected = app === undefined ? true : appIsConnected(app, input.connections);
  if (app !== undefined && !connected) {
    return {
      layer: "connection",
      kind: "needs_connection",
      app,
      provider: app === "calendar" ? "google-calendar" : "gmail",
      executable: false,
    };
  }
  return {
    layer: "card",
    kind: "draft",
    intent: capability.intent,
    connected,
    executable: false,
  };
}

/** Route a request that is only "open this page". */
export function routeWebRequest(input: { url: string }): LayerRoute {
  return { layer: "web", kind: "web", url: input.url, connected: false, executable: false };
}

/**
 * The one sentence a turn may say about a route, so no caller invents a stronger claim.
 *
 * These are deliberately narrow. A page says it opened a page; a catalog entry says the app can
 * be connected; a connection says it still needs the person; a discovered tool says it was
 * found; only an executed one says anything happened.
 */
export function describeRoute(route: LayerRoute): string {
  switch (route.kind) {
    case "web":
      return "已在浏览器中打开这个页面；这没有连接任何应用，也没有执行任何操作。";
    case "catalog":
      return route.connected
        ? "这个应用已经连接；接下来可以创建草稿。"
        : "这个应用可以连接，但还没有授权。";
    case "needs_connection":
      return route.app === "calendar"
        ? "要先连接日历，才能创建日程。"
        : "要先连接邮箱，才能起草或发送邮件。";
    case "discovered":
      return "找到了可以使用的工具；还没有执行，先确认要做什么。";
    case "executed":
      return "已经执行，执行记录可以核对。";
    case "draft":
      return "草稿已准备好，请在卡片上确认。";
  }
}
