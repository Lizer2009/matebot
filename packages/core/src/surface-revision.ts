/**
 * Multi-turn surface revision, kept as pure functions so the same rules run in
 * the API, in tests, and in the simulator.
 *
 * One task keeps one surface across turns. Every accepted change bumps the
 * revision, a late or replayed event is dropped rather than rewinding the card,
 * a field the user typed into is never overwritten by a model update, and
 * changing an approved payload invalidates that approval. An executed task is
 * immutable: a correction is a new draft linked to it.
 */

export type SurfaceStatus = "draft" | "approved" | "executed";

export type SurfaceRevisionState = {
  taskId: string;
  surfaceId: string;
  revision: number;
  status: SurfaceStatus;
  values: Record<string, unknown>;
  /** Fields the user changed directly or asked for in prose. Model may not overwrite them. */
  editedFields: string[];
  /** Set on a draft created to correct an executed one. */
  amendsTaskId?: string;
};

export type SurfaceEventDecision =
  | { accept: true }
  | { accept: false; reason: "stale" | "different_surface" };

/**
 * Whether an update from the server or model may touch this surface.
 * Equal revisions are replays; lower ones are late deliveries. Both are dropped
 * so the card cannot jump back to an older state under the user's cursor.
 */
export function acceptSurfaceEvent(
  state: SurfaceRevisionState,
  event: { revision: number; surfaceId?: string },
): SurfaceEventDecision {
  if (event.surfaceId !== undefined && event.surfaceId !== state.surfaceId) {
    return { accept: false, reason: "different_surface" };
  }
  if (event.revision <= state.revision) return { accept: false, reason: "stale" };
  return { accept: true };
}

export type SurfaceEditInput = {
  name: string;
  value: unknown;
  /** A direct edit or prose rewrite is the user's; a model fill is not. */
  origin?: "user" | "model" | "amendment";
  /** Required when amending an executed task: the new task this draft belongs to. */
  newTaskId?: string;
};

/**
 * Apply one change. Returns the next state or throws when the surface is
 * immutable and the caller tried to edit it in place.
 */
export function applySurfaceEdit(
  state: SurfaceRevisionState,
  input: SurfaceEditInput,
): SurfaceRevisionState {
  const origin = input.origin ?? "user";

  if (state.status === "executed") {
    if (origin !== "amendment" || !input.newTaskId) {
      throw new Error("An executed surface is immutable; amend it with a new draft");
    }
    // A correction starts a fresh task that points at the original record.
    return {
      taskId: input.newTaskId,
      surfaceId: state.surfaceId,
      revision: 1,
      status: "draft",
      values: { ...state.values, [input.name]: input.value },
      editedFields: [input.name],
      amendsTaskId: state.taskId,
    };
  }

  // The user's own typing wins over a model fill for the same field.
  if (origin === "model" && state.editedFields.includes(input.name)) {
    return state;
  }

  if (state.values[input.name] === input.value) return state;

  const editedFields =
    origin === "model"
      ? state.editedFields
      : state.editedFields.includes(input.name)
        ? state.editedFields
        : [...state.editedFields, input.name];

  return {
    ...state,
    revision: state.revision + 1,
    // Changing an approved payload means the approval no longer describes it.
    status: state.status === "approved" ? "draft" : state.status,
    values: { ...state.values, [input.name]: input.value },
    editedFields,
  };
}

/**
 * Whether a submit may run: the click must carry the exact revision on screen,
 * and the payload must still be the one that was approved.
 */
export function canSubmitSurface(input: {
  state: SurfaceRevisionState;
  submittedRevision: number;
}): { ok: true } | { ok: false; error: "stale_revision" | "not_approved" | "already_executed" } {
  if (input.state.status === "executed") return { ok: false, error: "already_executed" };
  if (input.submittedRevision !== input.state.revision)
    return { ok: false, error: "stale_revision" };
  if (input.state.status !== "approved") return { ok: false, error: "not_approved" };
  return { ok: true };
}
