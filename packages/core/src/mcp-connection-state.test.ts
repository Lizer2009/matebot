import { describe, expect, it } from "vitest";
import { mcpConnectionVerdict } from "./mcp-connection-state.js";

/**
 * Approval and health are different facts.
 *
 * The audit caught a card saying `Connected` while the next turn reported an
 * invalid key. Both statements were true of different things, and only one of them
 * belonged on the card. `connected` now requires a successful reach.
 */

describe("mcpConnectionVerdict", () => {
  it("is pending before the user approves", () => {
    expect(mcpConnectionVerdict({ approved: false })).toEqual({
      state: "pending",
      working: false,
    });
  });

  it("is dismissed when the user declined", () => {
    expect(mcpConnectionVerdict({ approved: false, dismissed: true })).toMatchObject({
      state: "dismissed",
      working: false,
    });
  });

  it("claims connected only when discovery actually succeeded", () => {
    expect(mcpConnectionVerdict({ approved: true, health: { status: "ok" } })).toEqual({
      state: "connected",
      working: true,
    });
  });

  it("does not claim connected for an approved server that was never reached", () => {
    // This is the audit's case: approval recorded, nothing had spoken to it yet.
    expect(mcpConnectionVerdict({ approved: true, health: { status: "unknown" } })).toEqual({
      state: "not_checked",
      working: false,
    });
    expect(mcpConnectionVerdict({ approved: true })).toMatchObject({ state: "not_checked" });
  });

  it("carries the server's own failure reason when it failed", () => {
    expect(
      mcpConnectionVerdict({
        approved: true,
        health: { status: "error", message: "Invalid or revoked API key" },
      }),
    ).toEqual({
      state: "needs_attention",
      working: false,
      detail: "Invalid or revoked API key",
    });
  });

  it("treats a stdio install in progress as preparing, not connected", () => {
    expect(
      mcpConnectionVerdict({ approved: true, health: { status: "installing" } }),
    ).toMatchObject({
      state: "preparing",
      working: false,
    });
  });

  it("never reports working for anything but ok", () => {
    for (const status of ["unknown", "installing", "error"] as const) {
      expect(mcpConnectionVerdict({ approved: true, health: { status } }).working).toBe(false);
    }
  });

  it("ignores a blank failure message rather than showing an empty reason", () => {
    const verdict = mcpConnectionVerdict({
      approved: true,
      health: { status: "error", message: "   " },
    });
    expect(verdict.state).toBe("needs_attention");
    expect(verdict.detail).toBeUndefined();
  });
});
