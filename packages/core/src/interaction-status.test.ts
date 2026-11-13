import { describe, expect, it } from "vitest";
import {
  INTERACTION_STATUSES,
  isAutoSettleable,
  isEditableStatus,
  isOpenStatus,
  isTerminalStatus,
  OPEN_STATUSES,
  SETTLE_EXEMPT_STATUSES,
  surfaceStatusFor,
  TERMINAL_STATUSES,
} from "./interaction-status.js";

describe("interaction status vocabulary", () => {
  it("has exactly the thirteen values the spec fixes", () => {
    expect([...INTERACTION_STATUSES].sort()).toEqual(
      [
        "awaiting_approval",
        "cancelled",
        "collecting",
        "confirmed",
        "executed",
        "expired",
        "failed",
        "needs_connection",
        "ready_for_review",
        "sent",
        "succeeded",
        "superseded",
        "unknown",
      ].sort(),
    );
  });

  // Every status must belong to exactly one bucket. A gap here is how `superseded`
  // once fell through to "draft" and rendered a live Send button.
  it("partitions every status into open, exempt, or terminal", () => {
    for (const status of INTERACTION_STATUSES) {
      const buckets = [
        isOpenStatus(status),
        SETTLE_EXEMPT_STATUSES.includes(status as never),
        isTerminalStatus(status),
      ].filter(Boolean);
      expect(buckets, `status ${status} must belong to exactly one bucket`).toHaveLength(1);
    }
  });

  it("treats only the three confirmable states as open", () => {
    expect([...OPEN_STATUSES]).toEqual(["collecting", "ready_for_review", "awaiting_approval"]);
  });

  it("refuses to auto-settle a waiting connection", () => {
    // D1: settling it would break the reconnect resume and could publish a different card.
    expect(isAutoSettleable("needs_connection")).toBe(false);
  });

  it("refuses to auto-settle an in-doubt email", () => {
    // D2: the mail may already be out; settling it would tell the user a lie.
    expect(isAutoSettleable("unknown")).toBe(false);
  });

  it("auto-settles the three open states", () => {
    for (const status of OPEN_STATUSES) expect(isAutoSettleable(status)).toBe(true);
  });

  it("keeps terminal states out of the editable set", () => {
    for (const status of TERMINAL_STATUSES) expect(isEditableStatus(status)).toBe(false);
  });

  it("lets a waiting connection be edited by reconnect rather than by text", () => {
    expect(isEditableStatus("needs_connection")).toBe(false);
  });

  it("rejects a status the vocabulary does not know", () => {
    expect(isOpenStatus("stale")).toBe(false);
    expect(isTerminalStatus("draft")).toBe(false);
  });

  // The one read-side mapping. Every terminal status is executed, so a
  // superseded or expired card can never reach the edit chooser as a draft.
  it("maps terminal statuses to executed and only awaiting_approval to approved", () => {
    expect(surfaceStatusFor("awaiting_approval")).toBe("approved");
    for (const status of TERMINAL_STATUSES) expect(surfaceStatusFor(status)).toBe("executed");
    for (const status of OPEN_STATUSES.filter((value) => value !== "awaiting_approval")) {
      expect(surfaceStatusFor(status)).toBe("draft");
    }
    expect(surfaceStatusFor("needs_connection")).toBe("draft");
    expect(surfaceStatusFor("unknown")).toBe("draft");
  });
});
