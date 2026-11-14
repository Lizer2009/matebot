import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { interactionHarness, rpc } from "../a2ui-route-harness.js";

// The routes 404 while the flag is off, which is the shipped default.
beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => vi.unstubAllEnvs());

/**
 * The edit chooser used to keep a denylist and map every unrecognised status to
 * "draft", so a `superseded` card was offered as a live draft the model could
 * rewrite. These go through the real route, so a returned denylist fails here:
 * the card then maps to "draft", survives `resolveSurfaceTarget`'s executed
 * filter, and the edit lands.
 *
 * The harness ignores `where`, so the query is not exercised at SQL level; what
 * is exercised is what the route does with a row it was handed. Real Postgres
 * coverage lives in the `.postgres.test.ts` suites.
 */
describe("threads.editInteraction card status", () => {
  it("refuses a superseded card instead of editing it as a draft", async () => {
    const h = interactionHarness({ interaction: { status: "superseded" } });
    const { status, json } = await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      revision: 2,
      fields: { subject: "after superseded" },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("no_open_surface");
    // Nothing was written and no surface was republished.
    expect(h.published).toEqual([]);
    expect(h.row.slots.subject).toBe("Hi");
  });

  it("refuses an expired card instead of editing it as a draft", async () => {
    const h = interactionHarness({ interaction: { status: "expired" } });
    const { status, json } = await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      revision: 2,
      fields: { subject: "after expiry" },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("no_open_surface");
    expect(h.published).toEqual([]);
    expect(h.row.slots.subject).toBe("Hi");
  });

  // The point is not "refuse everything": a card awaiting approval is still the
  // user's to correct, and must stay a target. (Over the route, `approved` and
  // `draft` are indistinguishable — only `executed` is filtered — so this pins
  // the outcome, not the literal.)
  it("still edits a card awaiting approval", async () => {
    const h = interactionHarness({ interaction: { status: "awaiting_approval" } });
    const { status, json } = await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      revision: 2,
      fields: { subject: "corrected before approval" },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ json: { ok: true, interactionId: "ix-1" } });
    expect(h.published).toHaveLength(1);
    expect(h.row.slots.subject).toBe("corrected before approval");
  });
});
