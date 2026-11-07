import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { interactionHarness, rpc } from "./a2ui-route-harness.js";

beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => vi.unstubAllEnvs());

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

  it("refuses while the action is in flight", async () => {
    const h = interactionHarness({ interaction: { status: "executing" } });
    const { status } = await rpc(h.handler, "threads/cancelInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
    });
    expect(status).toBe(409);
    expect(h.published).toEqual([]);
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
