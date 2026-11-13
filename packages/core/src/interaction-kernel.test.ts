import { describe, expect, it } from "vitest";
import type { SettleRefusal } from "./interaction-kernel.js";
import { decideSettle, expiresAtFor } from "./interaction-kernel.js";
import {
  INTERACTION_STATUSES,
  isTerminalStatus,
  SETTLE_EXEMPT_STATUSES,
} from "./interaction-status.js";

const REFUSALS: readonly SettleRefusal[] = [
  "already_terminal",
  "exempt_from_settlement",
  "unknown_status",
  "same_status",
  "not_terminal_target",
];

describe("decideSettle", () => {
  it("settles an open card to a terminal state", () => {
    expect(decideSettle({ current: "ready_for_review", next: "superseded" })).toEqual({
      ok: true,
      status: "superseded",
    });
  });

  it("refuses to settle the same status twice", () => {
    expect(decideSettle({ current: "sent", next: "sent" })).toEqual({
      ok: false,
      reason: "same_status",
    });
  });

  it("refuses to leave a terminal state", () => {
    expect(decideSettle({ current: "executed", next: "superseded" })).toEqual({
      ok: false,
      reason: "already_terminal",
    });
  });

  // D1 / D2: these two may never be closed by a sweep.
  it.each([...SETTLE_EXEMPT_STATUSES])("refuses to settle a %s card", (current) => {
    expect(decideSettle({ current, next: "superseded" })).toEqual({
      ok: false,
      reason: "exempt_from_settlement",
    });
  });

  // The check order matters: an exempt status asked for the status it already has
  // is a no-op, not an exemption.
  it("checks the same status before the exempt rule", () => {
    expect(decideSettle({ current: "needs_connection", next: "needs_connection" })).toEqual({
      ok: false,
      reason: "same_status",
    });
  });

  it("refuses a status the vocabulary does not know", () => {
    expect(decideSettle({ current: "stale", next: "superseded" })).toEqual({
      ok: false,
      reason: "unknown_status",
    });
  });

  // Settling closes a card, so the target must leave the workflow for good.
  it.each(["needs_connection", "ready_for_review"] as const)(
    "refuses to settle into the non-terminal status %s",
    (next) => {
      expect(decideSettle({ current: "collecting", next })).toEqual({
        ok: false,
        reason: "not_terminal_target",
      });
    },
  );

  // Exhaustive: every (known) pair either settles to a terminal `next` or names
  // one of the five reasons.
  it("decides every pair of known statuses without throwing", () => {
    for (const current of INTERACTION_STATUSES) {
      for (const next of INTERACTION_STATUSES) {
        const decision = decideSettle({ current, next });
        if (decision.ok) {
          expect(decision.status).toBe(next);
          expect(isTerminalStatus(next)).toBe(true);
        } else {
          expect(REFUSALS).toContain(decision.reason);
        }
      }
    }
  });
});

describe("expiresAtFor", () => {
  const now = new Date("2026-11-13T00:00:00.000Z");

  it("gives an approval card thirty minutes", () => {
    expect(expiresAtFor("awaiting_approval", now)?.toISOString()).toBe("2026-11-13T00:30:00.000Z");
  });

  it("leaves a card the user is editing open", () => {
    expect(expiresAtFor("ready_for_review", now)).toBeNull();
    expect(expiresAtFor("collecting", now)).toBeNull();
  });

  it("never expires a waiting connection", () => {
    // A sign-in takes as long as it takes; a timer here would break the resume.
    expect(expiresAtFor("needs_connection", now)).toBeNull();
  });

  it("never expires an in-doubt email", () => {
    expect(expiresAtFor("unknown", now)).toBeNull();
  });

  it("does not resurrect an expiry on a terminal card", () => {
    expect(expiresAtFor("sent", now)).toBeNull();
  });
});
