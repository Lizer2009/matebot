import { describe, expect, it } from "vitest";
import { emailSurfacePhase } from "./interaction-template.js";

/**
 * Both hosts used to derive the card's phase and lock state with the same
 * copy-pasted expression. One drifted change would mean the Send button is live
 * on one host and disabled on the other — a correctness bug. These pin the rule
 * the shared function owns.
 */

describe("emailSurfacePhase", () => {
  it("is an unlocked draft when a ready draft is shown", () => {
    const result = emailSurfacePhase({ capability: "ready" });
    expect(result).toMatchObject({ phase: "email-draft-card", locked: false, settled: false });
  });

  // A local submit shows progress before the server stamp arrives.
  it("shows progress while this client is submitting", () => {
    const result = emailSurfacePhase({ capability: "ready", busy: true });
    expect(result.phase).toBe("action-progress-card");
    expect(result.locked).toBe(true);
  });

  it("locks every terminal phase", () => {
    for (const template of [
      "action-submitting-card",
      "action-progress-card",
      "action-result-success",
      "action-result-failed",
      "action-reconcile-card",
    ] as const) {
      const result = emailSurfacePhase({ template, capability: "ready" });
      expect(result.locked).toBe(true);
    }
  });

  it("does not treat a draft or connection card as settled", () => {
    expect(emailSurfacePhase({ capability: "not_connected" }).settled).toBe(false);
    expect(emailSurfacePhase({ capability: "ready" }).settled).toBe(false);
  });

  it("marks success, failure, and UNKNOWN as settled", () => {
    // Blocks carry `lifecycle`, not the interaction status, so that is the input.
    for (const lifecycle of ["succeeded", "failed", "unknown"] as const) {
      expect(
        emailSurfacePhase({ intent: "email.compose", capability: "ready", lifecycle }).settled,
      ).toBe(true);
    }
  });

  // A snapshot written before templates existed carries no stamp at all.
  it("still resolves a legacy block with no template or lifecycle", () => {
    const result = emailSurfacePhase({ intent: "email.compose" });
    expect(result).toMatchObject({ phase: "email-draft-card", locked: false });
  });

  it("keeps a legacy connection stamp working", () => {
    const result = emailSurfacePhase({ intent: "email.compose", capability: "not_connected" });
    expect(result.phase).toBe("email-connection-card");
    expect(result.locked).toBe(false);
  });
});
