import { LAYER_DISCIPLINE_PROMPT } from "@matebot/core";
import { describe, expect, it } from "vitest";
import {
  annotateAppCatalog,
  annotateAppConnected,
  annotateConnectorCall,
  annotateWebEntry,
  effectDidExecute,
  withRouteAnnotation,
} from "./route-annotation.js";

/**
 * One shape for every surface that reports how far a request got.
 *
 * The point of collecting these here is that three tools used to answer the question separately
 * and disagreed: only the page opener distinguished a page from a connection. A shared module is
 * only worth having if the answers stay consistent, so these pin the invariants across all of
 * them rather than one tool at a time.
 */

describe("every annotation says the same thing the same way", () => {
  it("marks a page as unconnected and unexecuted", () => {
    expect(annotateWebEntry("https://example.test")).toMatchObject({
      route: { layer: "web", kind: "web", connected: false, executed: false, effectId: null },
    });
  });

  it("marks a connected app as connected but not executed", () => {
    expect(annotateAppConnected()).toMatchObject({
      route: { layer: "connection", kind: "connected", connected: true, executed: false },
    });
  });

  it("marks a catalog card as neither connected nor executed", () => {
    expect(annotateAppCatalog()).toMatchObject({
      route: { layer: "catalog", kind: "catalog", connected: false, executed: false },
    });
  });

  it("never reports an effect id for anything that did not execute", () => {
    const annotations = [
      annotateWebEntry("https://example.test"),
      annotateAppConnected(),
      annotateAppCatalog(),
      annotateConnectorCall({ tool: "COMPOSIO_SEARCH_TOOLS" }),
      // A name that looks like an action, with no ledger row behind it.
      annotateConnectorCall({ tool: "GMAIL_SEND_EMAIL" }),
    ];
    for (const annotation of annotations) {
      expect(annotation.route.executed).toBe(false);
      expect(annotation.route.effectId).toBeNull();
    }
  });

  it("reports an effect id only for a call the ledger recorded", () => {
    expect(annotateConnectorCall({ tool: "GMAIL_SEND_EMAIL", effectId: "effect-1" })).toMatchObject(
      { route: { executed: true, effectId: "effect-1" } },
    );
  });

  it("leaves a non-object result alone rather than wrapping it", () => {
    expect(withRouteAnnotation("plain text", annotateWebEntry(undefined))).toBe("plain text");
    expect(withRouteAnnotation(undefined, annotateWebEntry(undefined))).toBeUndefined();
  });

  it("does not drop what the tool already reported", () => {
    const merged = withRouteAnnotation(
      { messageId: "m-1" },
      annotateWebEntry("https://a.test"),
    ) as {
      messageId: string;
      route: { layer: string };
    };
    expect(merged).toMatchObject({ messageId: "m-1" });
    expect(merged.route.layer).toBe("web");
  });
});

describe("the model is told the same discipline the results carry", () => {
  it("states each boundary the annotations enforce", () => {
    // If the prompt and the annotations drift, a model can follow one and contradict the other.
    expect(LAYER_DISCIPLINE_PROMPT).toContain("Opening a page");
    expect(LAYER_DISCIPLINE_PROMPT).toContain("not connecting an app");
    expect(LAYER_DISCIPLINE_PROMPT).toContain("catalog");
    expect(LAYER_DISCIPLINE_PROMPT).toContain("tool search");
    expect(LAYER_DISCIPLINE_PROMPT).toContain("A draft card is not an action");
    expect(LAYER_DISCIPLINE_PROMPT).toContain("executed: false");
  });

  it("does not ask the model to run a classifier or name internal kinds", () => {
    // The instruction is about claims, not about calling a function or echoing enum values.
    expect(LAYER_DISCIPLINE_PROMPT).not.toMatch(/call .*classify|routeWebRequest|classifyToolCall/);
  });
});

describe("an effect row existing is not proof the tool ran", () => {
  it("reports not-executed while the effect is still intended", () => {
    // The ledger row is created before the tool runs. Reading its id as "it happened" is exactly
    // the overclaim this whole phase exists to remove.
    const pending = annotateConnectorCall({
      tool: "GMAIL_SEND_EMAIL",
      effectId: "effect-1",
      effectStatus: "intended",
    });
    expect(pending.route).toMatchObject({ executed: false, effectId: null });
  });

  it("reports not-executed while the effect is only approved", () => {
    const approved = annotateConnectorCall({
      tool: "GMAIL_SEND_EMAIL",
      effectId: "effect-1",
      effectStatus: "approved",
    });
    expect(approved.route).toMatchObject({ executed: false, effectId: null });
  });

  it("reports executed for each status a completed attempt ends in", () => {
    for (const effectStatus of ["executing", "completed", "uncertain"]) {
      const done = annotateConnectorCall({
        tool: "GMAIL_SEND_EMAIL",
        effectId: "effect-1",
        effectStatus,
      });
      expect(done.route, effectStatus).toMatchObject({ executed: true, effectId: "effect-1" });
    }
  });

  it("treats an unknown status as not executed", () => {
    expect(effectDidExecute("something-new")).toBe(false);
    expect(effectDidExecute(undefined)).toBe(false);
    expect(effectDidExecute("")).toBe(false);
  });
});
