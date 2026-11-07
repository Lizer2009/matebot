import { mcpConnectionVerdict } from "@matebot/core";
import { describe, expect, it } from "vitest";
import { MCP_HEALTH_RESET, mcpServerHealthDto } from "./mcp-server-health.js";

/**
 * A replaced credential must reach a recovered health state, not a stale one.
 *
 * The audit saw a card say `Connected` while the server reported an invalid key,
 * then a new key saved while the registered connection still held the old one. The
 * pieces exist — a probe writes health, the settings screen reads it, the card reads
 * the same field — but nothing exercised the whole path from "the key changed" to
 * "the card says it works again". These do, at the boundary where health is decided.
 */

describe("health after a credential change", () => {
  it("starts unknown when the configuration changes, so nothing claims success", () => {
    // The update route resets health for exactly this reason: the old verdict was
    // about settings that no longer apply.
    expect(MCP_HEALTH_RESET).toEqual({
      healthStatus: "unknown",
      healthMessage: null,
      healthToolCount: null,
      healthCheckedAt: null,
    });
  });

  it("does not let a card say connected while health is unknown", () => {
    const verdict = mcpConnectionVerdict({
      approved: true,
      health: { status: "unknown", message: null },
    });
    expect(verdict.state).toBe("not_checked");
    expect(verdict.working).toBe(false);
  });

  it("does not let a card say connected while the old key still fails", () => {
    const verdict = mcpConnectionVerdict({
      approved: true,
      health: { status: "error", message: "Invalid or revoked API key" },
    });
    expect(verdict.state).toBe("needs_attention");
    expect(verdict.detail).toBe("Invalid or revoked API key");
    expect(verdict.working).toBe(false);
  });

  it("says connected once a probe after the new key succeeds", () => {
    const verdict = mcpConnectionVerdict({
      approved: true,
      health: { status: "ok", message: null },
    });
    expect(verdict).toEqual({ state: "connected", working: true });
  });
});

describe("health dto", () => {
  it("carries the recovery through to what the route returns", () => {
    const row = {
      healthStatus: "ok",
      healthMessage: null,
      healthToolCount: 4,
      healthCheckedAt: new Date("2026-11-07T12:00:00Z"),
    };
    expect(mcpServerHealthDto(row)).toMatchObject({ status: "ok", toolCount: 4 });
    // And the verdict a card derives from that dto agrees.
    expect(mcpConnectionVerdict({ approved: true, health: mcpServerHealthDto(row) })).toEqual({
      state: "connected",
      working: true,
    });
  });

  it("passes a failure reason through unchanged, so the card can show it", () => {
    const dto = mcpServerHealthDto({
      healthStatus: "error",
      healthMessage: "Invalid or revoked API key",
      healthToolCount: null,
      healthCheckedAt: new Date("2026-11-07T12:00:00Z"),
    });
    expect(dto.message).toBe("Invalid or revoked API key");
    expect(mcpConnectionVerdict({ approved: true, health: dto }).detail).toBe(
      "Invalid or revoked API key",
    );
  });

  it("treats an unrecognised stored status as unknown rather than trusting it", () => {
    const dto = mcpServerHealthDto({
      healthStatus: "something-else",
      healthMessage: null,
      healthToolCount: null,
      healthCheckedAt: null,
    });
    expect(dto.status).toBe("unknown");
  });
});
