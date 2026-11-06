import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionDispatchDeps } from "./action-bridge.js";
import {
  dispatchInteractionAction,
  parseInteractionAction,
  resetInteractionActionState,
} from "./action-bridge.js";
import { INTERACTION_ACTION_EVENT } from "./compile-surface.js";

/**
 * The bridge is the only path from a clicked button to a server effect. These
 * tests exist because a compiled Button with no handler is a dead control:
 * every assertion here fails if a click can reach a route the server did not
 * allowlist.
 */

const schema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [{ name: "to", label: "To", kind: "email", required: true }],
  action: { id: "send", label: "Send", requiresRevision: true },
};

function action(overrides: Record<string, unknown> = {}) {
  return {
    name: `${INTERACTION_ACTION_EVENT}.send`,
    surfaceId: "surf-1",
    sourceComponentId: "action",
    timestamp: "2026-11-07T00:00:00.000Z",
    context: {
      interactionId: "ix-1",
      revision: 3,
    },
    ...overrides,
  };
}

function deps(overrides: Partial<InteractionDispatchDeps> = {}): InteractionDispatchDeps {
  return {
    loadInteraction: vi.fn(async () => ({
      id: "ix-1",
      threadId: "thread-1",
      intent: "email.compose",
      draftVersion: 3,
      schema,
    })),
    loadSurface: vi.fn(async () => ({ surfaceId: "surf-1" })),
    runAction: vi.fn(async () => ({ ok: true as const })),
    ownerOf: vi.fn(() => ({ spaceId: "space-1", userId: "user-1" })),
    ...overrides,
  };
}

beforeEach(() => {
  resetInteractionActionState();
});

describe("parseInteractionAction", () => {
  it("accepts an allowlisted action carrying an interaction and revision", () => {
    const parsed = parseInteractionAction(action());
    expect(parsed).toMatchObject({
      ok: true,
      actionId: "send",
      interactionId: "ix-1",
      surfaceId: "surf-1",
      revision: 3,
    });
  });

  it("rejects a name outside the interaction namespace", () => {
    expect(parseInteractionAction(action({ name: "deleteEverything" }))).toMatchObject({
      ok: false,
    });
  });

  // Shape parsing only knows the global allowlist; the per-surface check needs
  // the registered schema, so it belongs to dispatch (see below).
  it("accepts a globally allowlisted name the surface does not declare", () => {
    expect(
      parseInteractionAction(action({ name: `${INTERACTION_ACTION_EVENT}.create` })),
    ).toMatchObject({ ok: true, actionId: "create" });
  });

  it("rejects an action name outside the product allowlist", () => {
    expect(
      parseInteractionAction(action({ name: `${INTERACTION_ACTION_EVENT}.deleteEverything` })),
    ).toMatchObject({ ok: false });
  });

  it("rejects a payload with no interaction id or a bad revision", () => {
    expect(parseInteractionAction(action({ context: { revision: 3 } }))).toMatchObject({
      ok: false,
    });
    expect(
      parseInteractionAction(action({ context: { interactionId: "ix-1", revision: "3" } })),
    ).toMatchObject({ ok: false });
    expect(
      parseInteractionAction(action({ context: { interactionId: "ix-1", revision: 0 } })),
    ).toMatchObject({ ok: false });
  });
});

describe("dispatchInteractionAction", () => {
  it("runs the effect for a current revision", async () => {
    const d = deps();
    const result = await dispatchInteractionAction(action(), d);
    expect(result).toMatchObject({ ok: true });
    expect(d.runAction).toHaveBeenCalledWith(
      expect.objectContaining({ interactionId: "ix-1", actionId: "send", revision: 3 }),
    );
  });

  // A late click from an older surface must not execute against the newer draft.
  it("refuses a stale revision without running the action", async () => {
    const d = deps();
    const result = await dispatchInteractionAction(
      action({ context: { interactionId: "ix-1", revision: 2 } }),
      d,
    );
    expect(result).toMatchObject({ ok: false, error: "stale_revision" });
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("refuses a surface that does not belong to the interaction", async () => {
    const d = deps({ loadSurface: vi.fn(async () => null) });
    const result = await dispatchInteractionAction(action(), d);
    expect(result).toMatchObject({ ok: false, error: "unknown_surface" });
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("refuses an interaction the caller does not own", async () => {
    const d = deps({
      loadInteraction: vi.fn(async () => ({
        id: "ix-1",
        threadId: "thread-1",
        intent: "email.compose",
        draftVersion: 3,
        schema,
        spaceId: "other-space",
      })),
    });
    const result = await dispatchInteractionAction(action(), d);
    expect(result).toMatchObject({ ok: false, error: "forbidden" });
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("is idempotent: a repeated click on the same revision does not run twice", async () => {
    const d = deps();
    const first = await dispatchInteractionAction(action(), d);
    const second = await dispatchInteractionAction(action(), d);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(d.runAction).toHaveBeenCalledTimes(1);
  });

  it("refuses a globally allowlisted action the surface does not declare", async () => {
    const d = deps();
    const result = await dispatchInteractionAction(
      action({ name: `${INTERACTION_ACTION_EVENT}.create` }),
      d,
    );
    expect(result).toMatchObject({ ok: false, error: "unknown_action" });
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("refuses an action the registered schema no longer declares", async () => {
    const d = deps({
      loadInteraction: vi.fn(async () => ({
        id: "ix-1",
        threadId: "thread-1",
        intent: "email.compose",
        draftVersion: 3,
        // Same intent, but the capability now offers `save` instead of `send`.
        schema: { ...schema, action: { id: "save", label: "Save", requiresRevision: true } },
      })),
    });
    const result = await dispatchInteractionAction(action(), d);
    expect(result).toMatchObject({ ok: false, error: "unknown_action" });
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("propagates a failed action without claiming success", async () => {
    const d = deps({
      runAction: vi.fn(async () => ({ ok: false as const, error: "needs_reauth" as const })),
    });
    const result = await dispatchInteractionAction(action(), d);
    expect(result).toMatchObject({ ok: false, error: "needs_reauth" });
  });
});
