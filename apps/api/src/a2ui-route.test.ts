import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { interactionHarness, rpc } from "./a2ui-route-harness.js";

// The routes 404 while the flag is off, which is the shipped default. These
// tests opt in explicitly, exactly as a deployment would.
beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => vi.unstubAllEnvs());

/**
 * The gap this closes: the previous PR proved the dispatch service and the
 * browser click separately, but nothing exercised the route over HTTP. These
 * requests go through the real router, middleware, and handler, so a regression
 * in wiring (a missing route, a renamed field, a swallowed error) fails here.
 *
 * Real Postgres is unavailable in this environment; the Prisma client is in
 * memory, so SQL-level behaviour is not covered. That is stated, not hidden.
 */

describe("threads.editInteraction over HTTP", () => {
  it("applies a model edit, bumps the revision, and republishes the same surface", async () => {
    const h = interactionHarness({});
    const { status, json } = await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      revision: 2,
      fields: { subject: "秋后问候" },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      json: {
        ok: true,
        interactionId: "ix-1",
        surfaceId: "surf-1",
        draftVersion: 3,
        confirmationInvalidated: false,
      },
    });
    // One surface moved; no second card was created.
    expect(h.published).toEqual([{ draftVersion: 3, surfaceId: "surf-1" }]);
    expect(h.row.slots.subject).toBe("秋后问候");
  });

  it("refuses a stale revision over the wire, without writing", async () => {
    const h = interactionHarness({ interaction: { draftVersion: 5 } });
    const { json } = await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      revision: 2,
      fields: { subject: "stale" },
    });
    expect(JSON.stringify(json)).toContain("stale_revision");
    expect(h.published).toEqual([]);
    expect(h.row.slots.subject).toBe("Hi");
  });

  it("refuses a field the registered schema does not declare", async () => {
    const h = interactionHarness({});
    const { json } = await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      revision: 2,
      fields: { password: "hunter2" },
    });
    expect(JSON.stringify(json)).toContain("unknown_field");
    expect(h.published).toEqual([]);
  });

  it("invalidates an approval when the approved payload changes", async () => {
    const h = interactionHarness({
      interaction: { status: "awaiting_approval", confirmedVersion: 2 },
    });
    const { json } = await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      revision: 2,
      fields: { body: "changed after approval" },
    });
    expect(json).toMatchObject({ json: { ok: true, confirmationInvalidated: true } });
  });

  it("keeps a field the user typed when the model proposes it", async () => {
    const h = interactionHarness({});
    await rpc(h.handler, "threads/editInteraction", {
      botId: "bot-1",
      interactionId: "ix-1",
      revision: 2,
      fields: { subject: "model says otherwise" },
      userEditedFields: ["subject"],
    });
    expect(h.row.slots.subject).toBe("Hi");
  });
});

describe("threads.dispatchInteractionAction over HTTP", () => {
  // The route reaches the real confirm/execute services, which preflight the
  // mailbox. With no connector configured they refuse — the honest outcome.
  // This proves the route exists and routes into the effect path; it does not
  // prove a send, which needs a live provider and is not authorised here.
  it("routes the click into the real effect path, which refuses without a mailbox", async () => {
    const h = interactionHarness({
      interaction: { status: "awaiting_approval", confirmedVersion: 2 },
    });
    const { status, json } = await rpc(h.handler, "threads/dispatchInteractionAction", {
      botId: "bot-1",
      interactionId: "ix-1",
      surfaceId: "surf-1",
      action: "send",
      revision: 2,
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("action_failed");
    // Nothing was executed, so the row is untouched.
    expect(h.row.status).toBe("awaiting_approval");
  });

  it("refuses an action id the registered schema does not declare", async () => {
    const h = interactionHarness({
      interaction: { status: "awaiting_approval", confirmedVersion: 2 },
    });
    const { json } = await rpc(h.handler, "threads/dispatchInteractionAction", {
      botId: "bot-1",
      interactionId: "ix-1",
      surfaceId: "surf-1",
      action: "create",
      revision: 2,
    });
    expect(JSON.stringify(json)).toContain("unknown_action");
  });

  it("refuses a stale revision over the wire", async () => {
    const h = interactionHarness({
      interaction: { status: "awaiting_approval", confirmedVersion: 2, draftVersion: 4 },
    });
    const { json } = await rpc(h.handler, "threads/dispatchInteractionAction", {
      botId: "bot-1",
      interactionId: "ix-1",
      surfaceId: "surf-1",
      action: "send",
      revision: 2,
    });
    expect(JSON.stringify(json)).toContain("stale_revision");
  });
});
