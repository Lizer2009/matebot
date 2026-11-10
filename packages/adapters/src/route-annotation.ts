import type { LayerRoute } from "@matebot/core";
import { classifyToolCall, describeRoute, routeDidExecute, routeWebRequest } from "@matebot/core";

/**
 * The layer a tool result reached, in the one shape every tool reports.
 *
 * Three surfaces — opening a page, offering an app, and calling a connector — each know something
 * about how far a request got. Left to themselves they drifted: the page opener reported nothing,
 * the connector reported nothing, and the result of a *search* looked exactly like the result of
 * an action that ran. This module is the single place that turns a situation into the marker the
 * model reads, so the three cannot disagree about what "connected" or "executed" means.
 *
 * It annotates; it does not decide. Whether a card may be published, whether a tool may run — those
 * gates live where they always did. What changes is that the model is told the truth about what
 * happened, in the same words, wherever it looks.
 */

/** What a tool result carries. `route` is the machine-readable part, `routeNotice` the sentence. */
export type RouteAnnotation = {
  route: {
    layer: LayerRoute["layer"];
    kind: LayerRoute["kind"];
    /**
     * Whether an app connection exists at this point.
     *
     * Stated rather than inferred: a reader should not have to know that "layer: web" implies
     * "not connected". Only a route that has actually reached a live connection says true.
     */
    connected: boolean;
    executed: boolean;
    effectId: string | null;
    /**
     * For a web entry: whether the page actually opened.
     *
     * Absent for every other layer, which have no such question to answer.
     */
    opened?: boolean;
  };
  routeNotice: string;
};

function annotationFor(route: LayerRoute): RouteAnnotation {
  const executed = routeDidExecute(route);
  return {
    route: {
      layer: route.layer,
      kind: route.kind,
      // A catalog card is not a connection, and neither is a page or a discovered tool.
      connected: route.kind === "catalog" ? route.connected : false,
      executed,
      // Only an executed route has a ledger row to name. A discovered one has none, and saying
      // otherwise is the conflation this exists to prevent.
      effectId: route.kind === "executed" ? route.effectId : null,
      ...(route.kind === "web" ? { opened: route.opened } : {}),
    },
    routeNotice: describeRoute(route),
  };
}

/**
 * A page was opened in the browser: L1. It is not an app connection and runs nothing.
 *
 * `opened` is what the result says, not what was asked for. A navigation the browser refused —
 * a malformed URL, a non-http scheme, a host the egress guard blocked — must not be described as
 * a page that opened, or the model has a positive sentence for something that did not happen.
 */
export function annotateWebEntry(url: string | undefined, opened = true): RouteAnnotation {
  return annotationFor(routeWebRequest({ url: url ?? "about:blank", opened }));
}

/**
 * An effect status that means the tool actually ran.
 *
 * The ledger row is created *before* a tool runs, with status `intended`. So the existence of an
 * id is not evidence of execution — only a status the run reached after calling the tool is.
 * These are the statuses a completed attempt ends in; anything else is a plan or an approval.
 */
const EXECUTED_EFFECT_STATUSES: ReadonlySet<string> = new Set([
  "executing",
  "completed",
  "uncertain",
]);

/**
 * Whether this effect row shows the tool ran, as opposed to being requested or approved.
 *
 * A caller that does not know the status gets the conservative answer: not executed. The
 * annotation is what the model repeats to the person, so an unknown status must not become a
 * claim that something happened.
 */
export function effectDidExecute(status: string | null | undefined): boolean {
  return typeof status === "string" && EXECUTED_EFFECT_STATUSES.has(status);
}

/**
 * A connector call, classified from the ledger rather than from the tool name alone.
 *
 * `effectId` is the receipt, but only once the row says the tool ran. A call whose effect is still
 * `intended` — or approved and not yet run — is reported as discovered, because nothing has
 * happened yet even though a row exists.
 */
export function annotateConnectorCall(input: {
  tool: string;
  effectId?: string | null;
  effectStatus?: string | null;
}): RouteAnnotation {
  // A status the caller supplied must say the tool ran; a caller that supplies none is treated
  // as not having run, unless it is a tool that never gets an effect (a search).
  const ran = input.effectStatus === undefined ? true : effectDidExecute(input.effectStatus);
  return annotationFor(
    classifyToolCall({ tool: input.tool, effectId: ran ? input.effectId : null }),
  );
}

/** Merge an annotation onto a tool result without replacing what the tool already reported. */
export function withRouteAnnotation<T>(result: T, annotation: RouteAnnotation): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), ...annotation } as T;
}

/**
 * An app the person has connected. L3, satisfied: the connection exists, nothing has run.
 *
 * This uses the classifier's own vocabulary rather than a second set of labels. A connected app
 * is the same layer as `needs_connection` with its condition met — not `catalog`, which is the
 * layer for an app that was merely shown.
 */
export function annotateAppConnected(): Pick<RouteAnnotation, "route"> {
  return {
    route: {
      layer: "connection",
      kind: "connected",
      connected: true,
      executed: false,
      effectId: null,
    },
  };
}

/** A catalog card offering an app. L2: shown, not connected, and it has run nothing. */
export function annotateAppCatalog(): Pick<RouteAnnotation, "route"> {
  return {
    route: {
      layer: "catalog",
      kind: "catalog",
      connected: false,
      executed: false,
      effectId: null,
    },
  };
}
