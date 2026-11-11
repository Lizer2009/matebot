import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionDispatchServiceDeps } from "./interaction-dispatch.js";
import {
  dispatchInteractionActionService,
  resetInteractionDispatchState,
} from "./interaction-dispatch.js";
import { InteractionSendRejectedError } from "./interaction-service.js";

/**
 * The API layer of the one action bridge. These fail if a dispatch can reach an
 * effect without ownership, a matching surface, an approved payload, and the
 * exact revision — or if a repeated click runs twice.
 */

const schema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [{ name: "to", label: "To", kind: "email", required: true }],
  action: { id: "send", label: "Send", requiresRevision: true },
};

type Row = {
  id: string;
  spaceId: string;
  threadId: string;
  intent: string;
  status: "draft" | "approved" | "executed";
  draftVersion: number;
  confirmedVersion: number | null;
  schema: InteractionSurfaceSchema;
};

function deps(
  overrides: {
    row?: Partial<Row> | null;
    surface?: unknown;
    run?: { ok: true } | { ok: false; error: string };
  } = {},
): InteractionDispatchServiceDeps {
  const row: Row | null =
    overrides.row === null
      ? null
      : {
          id: "ix-1",
          spaceId: "space-1",
          threadId: "thread-1",
          intent: "email.compose",
          status: "approved",
          draftVersion: 3,
          confirmedVersion: 3,
          schema,
          ...overrides.row,
        };
  return {
    loadInteraction: vi.fn(async () => row),
    loadSurface: vi.fn(async () =>
      overrides.surface === undefined ? { surfaceId: "surf-1" } : overrides.surface,
    ),
    runAction: vi.fn(async () => overrides.run ?? { ok: true as const }),
  };
}

beforeEach(() => {
  resetInteractionDispatchState();
});

const input = {
  spaceId: "space-1",
  threadId: "thread-1",
  interactionId: "ix-1",
  surfaceId: "surf-1",
  action: "send",
  revision: 3,
};

describe("dispatchInteractionActionService", () => {
  it("runs the effect for an approved, current revision", async () => {
    const d = deps();
    const result = await dispatchInteractionActionService(d, input);
    expect(result).toMatchObject({ ok: true, duplicate: false, revision: 3 });
    expect(d.runAction).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale revision", async () => {
    const d = deps({ row: { draftVersion: 4 } });
    expect(await dispatchInteractionActionService(d, input)).toMatchObject({
      ok: false,
      error: "stale_revision",
    });
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("refuses a surface that is not the interaction's", async () => {
    const d = deps({ surface: null });
    expect(await dispatchInteractionActionService(d, input)).toMatchObject({
      ok: false,
      error: "unknown_surface",
    });
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("refuses an interaction in another space or thread", async () => {
    expect(
      await dispatchInteractionActionService(deps({ row: { spaceId: "space-2" } }), input),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      await dispatchInteractionActionService(deps({ row: { threadId: "thread-2" } }), input),
    ).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("refuses an unknown interaction", async () => {
    expect(await dispatchInteractionActionService(deps({ row: null }), input)).toMatchObject({
      ok: false,
      error: "unknown_interaction",
    });
  });

  // The click confirms the revision it carries, so a fresh draft is runnable —
  // but a click from an older revision is not (covered above by stale_revision).
  it("runs a fresh draft, because the click is the confirmation", async () => {
    const d = deps({ row: { confirmedVersion: null, status: "draft" } });
    expect(await dispatchInteractionActionService(d, input)).toMatchObject({ ok: true });
    expect(d.runAction).toHaveBeenCalledTimes(1);
  });

  it("refuses an action the schema does not declare", async () => {
    const d = deps();
    expect(await dispatchInteractionActionService(d, { ...input, action: "create" })).toMatchObject(
      { ok: false, error: "unknown_action" },
    );
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it("is idempotent for a repeated click", async () => {
    const d = deps();
    const first = await dispatchInteractionActionService(d, input);
    const second = await dispatchInteractionActionService(d, input);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(d.runAction).toHaveBeenCalledTimes(1);
  });

  it("reports a failed effect without claiming success", async () => {
    const d = deps({ run: { ok: false, error: "needs_connection" } });
    expect(await dispatchInteractionActionService(d, input)).toMatchObject({
      ok: false,
      error: "needs_connection",
    });
  });

  it("keeps a missing connection distinct from a failed action", async () => {
    // The effect path names why it refused. Collapsing that into `action_failed` is what made
    // the card's button look dead: the client had nothing specific to say.
    const refused = vi.fn(async () => {
      throw new InteractionSendRejectedError("needs_connection", "Connect a calendar first");
    });
    const d = deps({});
    d.runAction = refused;
    expect(await dispatchInteractionActionService(d, input)).toMatchObject({
      ok: false,
      error: "needs_connection",
    });

    const broken = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    const other = deps({});
    other.runAction = broken;
    expect(await dispatchInteractionActionService(other, input)).toMatchObject({
      ok: false,
      error: "action_failed",
    });
  });
});
