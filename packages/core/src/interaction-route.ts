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
      /**
       * A URL was opened for the person — or was asked for and could not be.
       *
       * `opened` matters: a navigation can be refused before the browser touches it (a bad URL,
       * a scheme that is not http, a host the egress guard already blocked). Reporting that as a
       * page that was opened hands the model a quotable sentence about something that did not
       * happen, which is the exact failure this module exists to prevent.
       */
      layer: "web";
      kind: "web";
      url: string;
      opened: boolean;
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
      /**
       * The app is authorized. This is the same layer as `needs_connection`, satisfied.
       *
       * It is deliberately not `catalog`: L2 means the app was merely shown, which is what an
       * unauthorized offer is. Reporting a live connection as L2 would put it *below* the
       * unconnected case in the layer order.
       */
      layer: "connection";
      kind: "connected";
      app: string;
      connected: true;
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

/**
 * A tool that returns tool *schemas* rather than acting: a catalog search, a schema load, or the
 * built-in `find_tool`.
 *
 * Every one of these hands the model a description of a tool and nothing more. They are the calls
 * whose result is most easily mistaken for capability, so they must say "discovered, not
 * executed".
 *
 * The match is by the suffix the catalog wrappers actually use (`_search_tools`, `_load_tool`)
 * rather than by any name containing "search": `GOOGLE_SEARCH_CONSOLE_SUBMIT_SITEMAP` writes and
 * `SLACK_SEARCH_MESSAGES` reads a workspace, and denying those their effect row would be the
 * opposite of what this predicate is for.
 *
 * This remains a name heuristic, which is why it is kept to suffixes: a connector whose wrapper
 * is named differently is not detected and is treated as an ordinary call. That failure is
 * visible in the ledger; the other one silently swallows a write.
 */
const DISCOVERY_TOOL = /(^|_)(SEARCH_TOOLS?|LOAD_TOOL)$|^find_tool$/i;

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
    layer: "connection",
    kind: "connected",
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
export function routeWebRequest(input: { url: string; opened?: boolean }): LayerRoute {
  return {
    layer: "web",
    kind: "web",
    url: input.url,
    opened: input.opened ?? true,
    connected: false,
    executable: false,
  };
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
      // Whether it opened is part of the fact, not an assumption.
      return route.opened
        ? "This page was opened in the browser. No app was connected and nothing was executed."
        : "This page was not opened. No app was connected and nothing was executed.";
    case "catalog":
      return "This app is offered in the catalog and is not connected yet.";
    case "connected":
      return "This app is connected. Nothing has been executed.";
    case "needs_connection":
      return route.app === "calendar"
        ? "A calendar must be connected before an event can be created."
        : "A mailbox must be connected before mail can be drafted or sent.";
    case "discovered":
      return "A tool was found. It has not been executed; confirm what to do first.";
    case "executed":
      return "This ran, and the execution record can be checked.";
    case "draft":
      return "The draft is ready. Confirm it on the card.";
  }
}

/**
 * The layer discipline, stated for the model rather than for a caller.
 *
 * The tool results carry a `route` and a `routeNotice`, but a model that has already decided what
 * to say can ignore both. This paragraph is the other half: the rule it is told to follow, in the
 * same words the results use, so a reply that claims a page was a connection, or a catalog entry
 * was a completed action, contradicts an instruction it was given.
 *
 * It is deliberately about *claims*, not about which tool to call: the model still chooses tools
 * from the situation, and nothing here asks it to run a classifier.
 */
export const LAYER_DISCIPLINE_PROMPT = [
  "Work happens in layers, and a later layer may only be claimed when its own evidence exists:",
  "- Opening a page in the browser is not connecting an app. It grants no access and runs nothing.",
  "- Showing an app in the catalog, or posting a card that offers to connect it, is not connecting it.",
  "- Connecting an app is not doing the work. Nothing has run until something actually runs.",
  "- A tool search returning schemas is not a completed action. Only a call that ran, and left a record, is.",
  "- A draft card is not an action. It waits for the person to confirm it.",
  "When a result carries a `route` with executed: false, say what was actually reached. Never tell the person an action happened because a tool returned something, and never describe a page you opened as an app you connected.",
  "A result's `routeNotice` states the fact in English. Convey it in the language you are replying in; do not paste the English sentence into a reply.",
].join("\n");
