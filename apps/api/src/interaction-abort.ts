/**
 * Abort handles for effects that are currently running.
 *
 * The spec (§6.5.2) says a cancel should request an abort *when the runtime
 * supports it*, and that a completed effect must never be described as undone.
 * This runtime does support it: a provider request carries `context.signal`, so
 * aborting the controller aborts the HTTP call underneath it.
 *
 * Two limits are deliberate and stated rather than hidden:
 *
 * - The registry is per process. A cancel that lands on another instance cannot
 *   abort this one's request; it is still refused as "in flight", which is the
 *   safe answer, and the outcome is settled by the normal finish path.
 * - Aborting is a *request*. The provider may already have accepted the work, so
 *   a cancelled-in-flight effect resolves as failed or UNKNOWN, never as
 *   "cancelled and nothing happened".
 *
 * Entries are keyed by effect id and carry the owning space, so one tenant can
 * never abort another tenant's request.
 */

type Entry = {
  spaceId: string;
  controller: AbortController;
};

const inFlight = new Map<string, Entry>();

/**
 * Register the controller for an effect about to reach a provider.
 *
 * The returned function unregisters it; the caller must call it in a `finally`
 * so a finished effect leaves nothing behind.
 */
export function registerInFlightEffect(input: {
  effectId: string;
  spaceId: string;
  controller: AbortController;
}): () => void {
  const entry: Entry = { spaceId: input.spaceId, controller: input.controller };
  inFlight.set(input.effectId, entry);
  return () => {
    // Only remove this exact entry: a retry may have registered a newer one.
    if (inFlight.get(input.effectId) === entry) inFlight.delete(input.effectId);
  };
}

export type AbortRequestOutcome =
  | { aborted: true }
  /** The effect is not running in this process (finished, or on another instance). */
  | { aborted: false; reason: "not_running" }
  /** A different tenant asked; nothing was aborted. */
  | { aborted: false; reason: "forbidden" };

/**
 * Ask a running effect to stop.
 *
 * Only an effect this process is running, in the caller's own space, can be
 * aborted. Everything else reports why, so the caller can say something true
 * instead of pretending the request was honoured.
 */
export function requestEffectAbort(input: {
  effectId: string;
  spaceId: string;
}): AbortRequestOutcome {
  const entry = inFlight.get(input.effectId);
  if (!entry) return { aborted: false, reason: "not_running" };
  if (entry.spaceId !== input.spaceId) return { aborted: false, reason: "forbidden" };
  entry.controller.abort();
  return { aborted: true };
}

/** Test seam: drop every registration. */
export function clearInFlightEffects(): void {
  inFlight.clear();
}

/** How many effects this process is currently running; used by tests and diagnostics. */
export function inFlightEffectCount(): number {
  return inFlight.size;
}
