import { describe, expect, it } from "vitest";
import { surfacePhase } from "./surface-phase.js";

describe("surfacePhase", () => {
  // AC-13: mail and calendar answer the same questions the same way.
  it("locks an in-flight card on both intents", () => {
    for (const intent of ["email.compose", "calendar.create"]) {
      expect(surfacePhase({ intent, status: "executing" })).toMatchObject({
        phase: "action-progress-card",
        locked: true,
      });
    }
  });

  it("folds a replaced card on both intents, with nothing to press", () => {
    for (const intent of ["email.compose", "calendar.create"]) {
      const phase = surfacePhase({ intent, status: "superseded" });
      expect(phase).toMatchObject({ phase: "action-superseded-card", settled: true, locked: true });
      expect(phase.affordance).toMatchObject({ action: "none", editable: false });
    }
  });

  it("keeps a waiting mailbox on its connection card", () => {
    expect(surfacePhase({ intent: "email.compose", status: "needs_connection" }).phase).toBe(
      "email-connection-card",
    );
    // A calendar card has no mailbox card to show; it stays an ordinary draft.
    expect(surfacePhase({ intent: "calendar.create", status: "needs_connection" }).phase).toBe(
      "action-draft-card",
    );
  });

  it("keeps a draft editable", () => {
    const phase = surfacePhase({ intent: "calendar.create", status: "ready_for_review" });
    expect(phase).toMatchObject({ locked: false, settled: false });
    expect(phase.affordance).toMatchObject({ editable: true, action: "submit" });
  });

  it("ignores a template string this build does not know", () => {
    expect(surfacePhase({ template: "not-a-template", status: "ready_for_review" }).phase).toBe(
      "action-draft-card",
    );
  });
});
