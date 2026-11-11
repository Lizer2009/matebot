import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { InteractionSurfaceSchema as InteractionSurfaceSchemaZ } from "@matebot/contracts";
import type { SurfaceStatus } from "@matebot/core";
import { canDispatchSurfaceAction, timingFields } from "@matebot/core";
import { getLogger } from "@matebot/logging";
import { codeOf } from "./interaction-run-action.js";

/**
 * The API half of the action bridge: everything the browser claims is checked
 * again here against the row the server owns.
 *
 * The browser sends an interaction id, a surface id, an action id, and the
 * revision the card was rendered from. None of that is trusted — it is compared
 * to the stored interaction, its registered schema, the caller's space and
 * thread, and the approved revision. Only then does the caller's effect run, and
 * a repeated click reports `duplicate` instead of executing twice.
 */

export type InteractionDispatchRow = {
  id: string;
  spaceId: string;
  threadId: string;
  intent: string;
  status: SurfaceStatus;
  draftVersion: number;
  confirmedVersion: number | null;
  schema: InteractionSurfaceSchema;
};

export type InteractionDispatchServiceInput = {
  spaceId: string;
  threadId: string;
  interactionId: string;
  surfaceId: string;
  action: string;
  revision: number;
};

export type InteractionDispatchServiceDeps = {
  loadInteraction: (interactionId: string) => Promise<InteractionDispatchRow | null>;
  loadSurface: (input: { interactionId: string; surfaceId: string }) => Promise<unknown | null>;
  runAction: (input: {
    interactionId: string;
    action: string;
    revision: number;
    row: InteractionDispatchRow;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export type InteractionDispatchServiceResult =
  | { ok: true; duplicate: boolean; interactionId: string; revision: number }
  | { ok: false; error: string };

/**
 * Clicks already run, keyed by the interaction, action, and revision. The
 * effect's idempotency key is the durable guard; this keeps the API from even
 * claiming a second time for a click still in flight.
 */
const clicks = new Map<string, "in_flight" | "done">();

export function resetInteractionDispatchState(): void {
  clicks.clear();
}

function clickKey(input: { interactionId: string; action: string; revision: number }) {
  return `${input.interactionId}:${input.action}:${input.revision}`;
}

export async function dispatchInteractionActionService(
  deps: InteractionDispatchServiceDeps,
  input: InteractionDispatchServiceInput,
): Promise<InteractionDispatchServiceResult> {
  const row = await deps.loadInteraction(input.interactionId);
  if (!row) return { ok: false, error: "unknown_interaction" };

  // The row must belong to the chat the caller asked through.
  if (row.spaceId !== input.spaceId || row.threadId !== input.threadId) {
    return { ok: false, error: "forbidden" };
  }

  const parsed = InteractionSurfaceSchemaZ.safeParse(row.schema);
  if (!parsed.success) return { ok: false, error: "invalid_schema" };
  if (parsed.data.action?.id !== input.action) return { ok: false, error: "unknown_action" };

  const surface = await deps.loadSurface({
    interactionId: input.interactionId,
    surfaceId: input.surfaceId,
  });
  if (!surface) return { ok: false, error: "unknown_surface" };

  // The click confirms the revision it carries and runs it in one gesture, so
  // the requirement is that the revision is the current one — a click from an
  // older surface is refused, which is what keeps a stale payload from sending.
  const gate = canDispatchSurfaceAction({
    state: {
      taskId: input.interactionId,
      surfaceId: input.surfaceId,
      revision: row.draftVersion,
      status: row.status,
      values: {},
      editedFields: [],
    },
    submittedRevision: input.revision,
  });
  if (!gate.ok) return { ok: false, error: gate.error };

  const key = clickKey({ ...input });
  const prior = clicks.get(key);
  if (prior) {
    return { ok: true, duplicate: true, interactionId: row.id, revision: input.revision };
  }

  const startedAt = Date.now();
  clicks.set(key, "in_flight");
  let outcome: { ok: true } | { ok: false; error: string };
  try {
    outcome = await deps.runAction({
      interactionId: input.interactionId,
      action: input.action,
      revision: input.revision,
      row,
    });
  } catch (error) {
    clicks.delete(key);
    // The effect path already names why it refused (a missing connection, an unconfirmed draft).
    // Replacing that with a single `action_failed` is what left the card's button looking dead:
    // the client had nothing specific to say. Carry the code the service chose.
    return { ok: false, error: codeOf(error) };
  }
  if (!outcome.ok) {
    clicks.delete(key);
    return { ok: false, error: outcome.error };
  }
  clicks.set(key, "done");
  // §9.6 instrumentation: the user's action was accepted and has run. Logged only
  // on a first dispatch, so a duplicate click does not inflate the count.
  getLogger().info("a2ui.action_confirmed", {
    ...timingFields({
      metric: "action-confirmed",
      ms: Date.now() - startedAt,
      origin: "run-created",
    }),
    "interaction.id": row.id,
    "surface.action": input.action,
    "surface.revision": input.revision,
  });
  return { ok: true, duplicate: false, interactionId: row.id, revision: input.revision };
}
