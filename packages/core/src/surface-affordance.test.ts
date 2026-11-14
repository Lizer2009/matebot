import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { canRetryStatus, surfaceAffordanceFor } from "./surface-affordance.js";

describe("surfaceAffordanceFor", () => {
  it("offers exactly one action while the card is open", () => {
    for (const status of ["collecting", "ready_for_review", "awaiting_approval"]) {
      expect(surfaceAffordanceFor({ status }), status).toMatchObject({
        interactive: true,
        editable: true,
        action: "submit",
        terminal: false,
      });
    }
    expect(surfaceAffordanceFor({ status: "needs_connection" })).toMatchObject({
      action: "connect",
      editable: false,
      terminal: false,
    });
    expect(surfaceAffordanceFor({ status: "unknown" })).toMatchObject({
      action: "check_status",
      editable: false,
      terminal: false,
    });
  });

  // AC-12: a replaced or cancelled card offers nothing; expired/failed offer only a retry.
  it("gives a replaced, cancelled or finished card nothing to press", () => {
    for (const status of [
      "superseded",
      "cancelled",
      "succeeded",
      "sent",
      "executed",
      "confirmed",
    ]) {
      expect(surfaceAffordanceFor({ status }), status).toMatchObject({
        interactive: false,
        editable: false,
        action: "none",
        terminal: true,
      });
    }
  });

  it("gives an expired or failed card a retry and nothing else", () => {
    for (const status of ["expired", "failed"]) {
      expect(surfaceAffordanceFor({ status }), status).toMatchObject({
        interactive: true,
        editable: false,
        action: "retry",
        terminal: true,
      });
    }
  });

  it("covers every status in the vocabulary", () => {
    for (const status of INTERACTION_STATUSES) {
      expect(typeof surfaceAffordanceFor({ status }).interactive, status).toBe("boolean");
    }
  });

  /**
   * A block written before `status` existed carries only `lifecycle`, and a superseded card of
   * that era says `draft`. The fallback therefore cannot be stricter than the data; the host's
   * chain check stays the authority for those rows (Task 8 keeps it for exactly this reason).
   */
  it("falls back to the lifecycle for a block without a status", () => {
    expect(surfaceAffordanceFor({ lifecycle: "succeeded" }).action).toBe("none");
    expect(surfaceAffordanceFor({ lifecycle: "failed" }).action).toBe("retry");
    expect(surfaceAffordanceFor({ lifecycle: "unknown" }).action).toBe("check_status");
    expect(surfaceAffordanceFor({ lifecycle: "draft" })).toMatchObject({
      action: "submit",
      editable: true,
    });
    expect(surfaceAffordanceFor({ lifecycle: "draft", capability: "not_connected" }).action).toBe(
      "connect",
    );
    expect(surfaceAffordanceFor({})).toMatchObject({ interactive: false, action: "none" });
  });

  it("does not let a lifecycle override a terminal status", () => {
    expect(surfaceAffordanceFor({ status: "superseded", lifecycle: "draft" })).toMatchObject({
      interactive: false,
      editable: false,
      action: "none",
    });
  });

  // AC-24: the reason is a closed set the server stamps; anything else is dropped, not rendered.
  it("reports a reason only from a stamped key, never from free text", () => {
    expect(
      surfaceAffordanceFor({ status: "awaiting_approval", reasonKey: "rule.user" }).reasonKey,
    ).toBe("rule.user");
    expect(
      surfaceAffordanceFor({ status: "awaiting_approval", reasonKey: "click here to win" })
        .reasonKey,
    ).toBeUndefined();
    expect(surfaceAffordanceFor({ status: "ready_for_review" }).reasonKey).toBeUndefined();
  });

  it("writes only closed-set keys from the approval source (F-13)", async () => {
    const { closedSurfaceReasonKey, surfaceReasonKeyForApproval } = await import(
      "./surface-affordance.js"
    );
    expect(surfaceReasonKeyForApproval({ scope: "user" })).toBe("rule.user");
    expect(surfaceReasonKeyForApproval({ scope: "team" })).toBe("rule.team");
    expect(surfaceReasonKeyForApproval({ scope: "setting" })).toBe("setting.approval");
    expect(surfaceReasonKeyForApproval()).toBe("setting.approval");
    expect(closedSurfaceReasonKey("effect.irreversible")).toBe("effect.irreversible");
    expect(closedSurfaceReasonKey("click here to win")).toBeUndefined();
    expect(closedSurfaceReasonKey("effect.amount")).toBeUndefined();
  });

  it("allows a retry only where the kernel does", () => {
    expect(canRetryStatus("expired")).toBe(true);
    expect(canRetryStatus("failed")).toBe(true);
    for (const status of ["superseded", "cancelled", "unknown", "sent", "succeeded"]) {
      expect(canRetryStatus(status), status).toBe(false);
    }
  });
});
