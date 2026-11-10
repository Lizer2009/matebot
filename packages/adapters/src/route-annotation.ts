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
    },
    routeNotice: describeRoute(route),
  };
}

/** A page was opened in the browser: L1. It is not an app connection and runs nothing. */
export function annotateWebEntry(url: string | undefined): RouteAnnotation {
  return annotationFor(routeWebRequest({ url: url ?? "about:blank" }));
}

/**
 * A connector call, classified from the ledger rather than from the tool name alone.
 *
 * `effectId` is the receipt. A call without one is reported as discovered even when its name looks
 * like an action, because nothing recorded that it ran.
 */
export function annotateConnectorCall(input: {
  tool: string;
  effectId?: string | null;
}): RouteAnnotation {
  return annotationFor(classifyToolCall(input));
}

/** Merge an annotation onto a tool result without replacing what the tool already reported. */
export function withRouteAnnotation<T>(result: T, annotation: RouteAnnotation): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), ...annotation } as T;
}

/**
 * An app the person has connected. L3: the connection exists, and nothing has been run yet.
 *
 * There is deliberately no route kind for this in the classifier — a connected app is a fact about
 * the world, not a step in a request — so the annotation states it directly. `executed` is always
 * false: connecting is not doing the work.
 */
export function annotateAppConnected(connected: boolean): Pick<RouteAnnotation, "route"> {
  return {
    route: {
      layer: "catalog",
      kind: "catalog",
      connected,
      executed: false,
      effectId: null,
    },
  };
}

/** A catalog card offering an app. L2: shown, not connected, and it has run nothing. */
export function annotateAppCatalog(connected: boolean): Pick<RouteAnnotation, "route"> {
  return annotateAppConnected(connected);
}
