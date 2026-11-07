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

/**
 * Whether a dispatched surface action may run.
 *
 * The primary button is a single gesture: the click confirms the revision it was
 * rendered from and runs it, so a separate "approved" state is not required (and
 * requiring it would break the shipped one-gesture Send). What is required is
 * that the click carries the exact revision currently on screen — a click from
 * an older surface is refused, which is what stops a stale payload from running.
 */
export function canDispatchSurfaceAction(input: {
  state: SurfaceRevisionState;
  submittedRevision: number;
}): { ok: true } | { ok: false; error: "stale_revision" | "already_executed" } {
  if (input.state.status === "executed") return { ok: false, error: "already_executed" };
  if (input.submittedRevision !== input.state.revision) {
    return { ok: false, error: "stale_revision" };
  }
  return { ok: true };
}

/**
 * Whether an already-approved payload may execute without another confirmation.
 * Kept separate from the dispatch gate above so the two rules stay explicit.
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
