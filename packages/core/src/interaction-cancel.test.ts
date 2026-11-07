import { describe, expect, it } from "vitest";
import { decideCancel, describeAmendment } from "./interaction-cancel.js";

/**
 * Cancelling is decided from the recorded state, not from the request. These pin
 * the boundary the spec draws: a draft that never ran can be cancelled, and a
 * record that already ran is never described as undone.
 */

describe("decideCancel", () => {
  it.each(["collecting", "needs_connection", "ready_for_review", "awaiting_approval"] as const)(
    "cancels a draft in %s",
    (status) => {
      expect(decideCancel({ status })).toEqual({ ok: true, status: "cancelled" });
    },
  );

  it("refuses to cancel a record that already executed and says it cannot be undone", () => {
    const decision = decideCancel({ status: "succeeded" });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.error).toBe("already_executed");
    expect(decision.message).toContain("无法撤销");
    expect(decision.message).toContain("关联草稿");
  });

  it("refuses while an action is in flight when the runtime cannot abort", () => {
    expect(decideCancel({ status: "executing" })).toMatchObject({
      ok: false,
      error: "in_flight",
    });
    expect(decideCancel({ status: "executing", runtimeCanAbort: false })).toMatchObject({
      ok: false,
      error: "in_flight",
    });
  });

  // §6.5.2: an abort may be requested only where the runtime supports it. This
  // one does, so the cancel asks rather than refusing outright.
  it("requests an abort while an action is in flight when the runtime supports it", () => {
    expect(decideCancel({ status: "executing", runtimeCanAbort: true })).toEqual({
      ok: true,
      status: "abort_requested",
    });
  });

  it("refuses to cancel an outcome that is not yet known", () => {
    expect(decideCancel({ status: "unknown" })).toMatchObject({ ok: false, error: "in_flight" });
  });

  it("does not re-cancel a draft that is already cancelled or failed", () => {
    expect(decideCancel({ status: "cancelled" })).toMatchObject({ ok: false, error: "terminal" });
    expect(decideCancel({ status: "failed" })).toMatchObject({ ok: false, error: "terminal" });
  });
});

describe("describeAmendment", () => {
  it("requires a new draft once the record executed", () => {
    expect(describeAmendment({ status: "succeeded" })).toEqual({
      allowed: true,
      requiresNewDraft: true,
    });
  });

  it("edits an unexecuted draft in place", () => {
    expect(describeAmendment({ status: "ready_for_review" })).toEqual({
      allowed: true,
      requiresNewDraft: false,
    });
  });
});
