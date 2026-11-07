import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { interactionHarness, rpc } from "./a2ui-route-harness.js";
import { clearInFlightEffects, registerInFlightEffect } from "./interaction-abort.js";

beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => {
  clearInFlightEffects();
  vi.unstubAllEnvs();
});
afterEach(() => clearInFlightEffects());

/**
 * `threads.cancelInteraction` over real HTTP.
 *
 * The point of these is that the refusal comes from the recorded state rather
 * than from the request: a draft the user never ran goes away, and a record that
 * already executed is kept and the caller is told cancelling would not undo it.
 */

describe("threads.cancelInteraction over HTTP", () => {
  it("cancels a draft that has not run and republishes it as cancelled", async () => {
    const h = interactionHarness({});
    const { status, json } = await rpc(h.handler, "threads/cancelInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ json: { ok: true, status: "cancelled", draftVersion: 3 } });
    expect(h.row.status).toBe("cancelled");
    // The card is republished in its new state, not deleted.
    expect(h.published).toEqual([{ draftVersion: 3, surfaceId: "surf-1" }]);
  });

  it("refuses a stale cancel instead of cancelling a draft it never saw", async () => {
    const h = interactionHarness({});
    const { status } = await rpc(h.handler, "threads/cancelInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 1,
    });
    expect(status).toBe(409);
    expect(h.row.status).toBe("ready_for_review");
    expect(h.published).toEqual([]);
  });

  it("refuses to cancel a record that already executed, and keeps its status", async () => {
    const h = interactionHarness({ interaction: { status: "succeeded" } });
    const { status, json } = await rpc(h.handler, "threads/cancelInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
    });
    expect(status).toBe(409);
    expect(JSON.stringify(json)).toContain("无法撤销");
    // The executed record is immutable: nothing was rewritten.
    expect(h.row.status).toBe("succeeded");
    expect(h.published).toEqual([]);
  });

  it("asks the running effect to stop instead of cancelling the row", async () => {
    const h = interactionHarness({
      interaction: { status: "executing", approvalEffectId: "effect-1" },
    });
    const controller = new AbortController();
    const release = registerInFlightEffect({
      effectId: "effect-1",
      spaceId: "space-1",
      controller,
    });
    try {
      const { status, json } = await rpc(h.handler, "threads/cancelInteraction", {
        botId: "bot-1",
        interactionId: "ix-1",
        draftVersion: 2,
      });
      // The runtime supports abort, so the request is made...
      expect(controller.signal.aborted).toBe(true);
      // ...and the row is deliberately left running: cancelling it now could
      // erase an effect that already happened.
      expect(status).toBe(409);
      expect(h.row.status).toBe("executing");
      expect(h.published).toEqual([]);
      expect(JSON.stringify(json)).toContain("以卡片最终状态为准");
    } finally {
      release();
    }
  });

  it("says plainly when a running effect is not in this process", async () => {
    const h = interactionHarness({
      interaction: { status: "executing", approvalEffectId: "effect-elsewhere" },
    });
    const { status, json } = await rpc(h.handler, "threads/cancelInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
    });
    expect(status).toBe(409);
    expect(h.row.status).toBe("executing");
    expect(JSON.stringify(json)).toContain("不在本进程内");
  });

  it("refuses to cancel an outcome that is not yet known", async () => {
    const h = interactionHarness({ interaction: { status: "unknown" } });
    const { status, json } = await rpc(h.handler, "threads/cancelInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
    });
    expect(status).toBe(409);
    // The message says it will be checked rather than treated as cancelled.
    expect(JSON.stringify(json)).toContain("不确定");
  });

  it("is absent while the feature flag is off", async () => {
    const h = interactionHarness({});
    vi.stubEnv("FEATURE_A2UI", "0");
    try {
      const { status } = await rpc(h.handler, "threads/cancelInteraction", {
        botId: "bot-1",
        interactionId: "ix-1",
        draftVersion: 2,
      });
      expect(status).toBeGreaterThanOrEqual(400);
    } finally {
      vi.stubEnv("FEATURE_A2UI", "1");
    }
  });
});
