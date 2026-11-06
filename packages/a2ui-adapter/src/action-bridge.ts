import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { InteractionSurfaceSchema as InteractionSurfaceSchemaZ } from "@matebot/contracts";
import { INTERACTION_ACTION_EVENT, INTERACTION_ALLOWED_ACTIONS } from "./compile-surface.js";

/**
 * The one bridge from a clicked A2UI control to a server effect.
 *
 * The renderer hands us an action payload the client produced, which is
 * untrusted: it may be replayed, stale, forged, or aimed at another thread. So
 * every field is re-checked here — the allowlisted action name, the interaction
 * and surface the server itself recorded, the caller's ownership, and the draft
 * revision the click was rendered from. Nothing reaches an effect until all of
 * that agrees, and a repeated click collapses instead of running twice.
 */

export type InteractionActionPayload = {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, unknown>;
};

export type ParsedInteractionAction =
  | {
      ok: true;
      actionId: string;
      interactionId: string;
      surfaceId: string;
      revision: number;
    }
  | { ok: false; error: string };

/**
 * Strip the namespace so only `<prefix>.<action>` reaches the allowlist, and
 * require the action to be one the product registered. Rejecting here keeps an
 * arbitrary button name out of the dispatch path entirely.
 */
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(INTERACTION_ALLOWED_ACTIONS);

function actionIdOf(name: string): string | null {
  const prefix = `${INTERACTION_ACTION_EVENT}.`;
  if (!name.startsWith(prefix)) return null;
  const id = name.slice(prefix.length).trim();
  if (!id || id.includes(".")) return null;
  return ALLOWED_ACTIONS.has(id) ? id : null;
}

/**
 * Shape-check a client action. This does not consult the database, so it is
 * cheap enough to run before any query; dispatch repeats the check with the
 * registered schema.
 */
export function parseInteractionAction(payload: unknown): ParsedInteractionAction {
  if (!payload || typeof payload !== "object") return { ok: false, error: "malformed_action" };
  const record = payload as Partial<InteractionActionPayload>;
  if (typeof record.name !== "string" || typeof record.surfaceId !== "string") {
    return { ok: false, error: "malformed_action" };
  }
  const actionId = actionIdOf(record.name);
  if (!actionId) return { ok: false, error: "unknown_action" };
  const context =
    record.context && typeof record.context === "object" && !Array.isArray(record.context)
      ? (record.context as Record<string, unknown>)
      : {};
  const interactionId =
    typeof context.interactionId === "string" ? context.interactionId.trim() : "";
  if (!interactionId) return { ok: false, error: "malformed_action" };
  const revision = context.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, error: "malformed_action" };
  }
  return {
    ok: true,
    actionId,
    interactionId,
    surfaceId: record.surfaceId,
    revision,
  };
}

/** The interaction row the bridge needs. Shaped to what the caller already has. */
export type InteractionActionRecord = {
  id: string;
  threadId: string;
  intent: string;
  draftVersion: number;
  schema: InteractionSurfaceSchema;
  spaceId?: string;
};

export type InteractionDispatchDeps = {
  loadInteraction: (interactionId: string) => Promise<InteractionActionRecord | null>;
  /** The surface row, so a stale surfaceId cannot address another interaction. */
  loadSurface: (input: { interactionId: string; surfaceId: string }) => Promise<unknown | null>;
  ownerOf: () => { spaceId: string; userId: string };
  /**
   * Runs the effect. The bridge only calls this after every check passes, and
   * never twice for the same interaction + revision + action.
   */
  runAction: (input: {
    interactionId: string;
    actionId: string;
    revision: number;
    record: InteractionActionRecord;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export type InteractionDispatchResult =
  | { ok: true; duplicate?: true }
  | { ok: false; error: string };

/**
 * Interactions already executed, keyed by what makes a click the same click.
 * In production the effect's idempotency key is the durable guard; this keeps
 * the bridge from even calling it twice for an in-flight or repeated click.
 */
const executed = new Map<string, "in_flight" | "done">();

function clickKey(input: { interactionId: string; actionId: string; revision: number }) {
  return `${input.interactionId}:${input.actionId}:${input.revision}`;
}

/** Test seam: production state lives in the effect's idempotency key. */
export function resetInteractionActionState(): void {
  executed.clear();
}

export async function dispatchInteractionAction(
  payload: unknown,
  deps: InteractionDispatchDeps,
): Promise<InteractionDispatchResult> {
  const parsed = parseInteractionAction(payload);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const record = await deps.loadInteraction(parsed.interactionId);
  if (!record) return { ok: false, error: "unknown_interaction" };

  const owner = deps.ownerOf();
  if (record.spaceId !== undefined && record.spaceId !== owner.spaceId) {
    return { ok: false, error: "forbidden" };
  }

  const parsedSchema = InteractionSurfaceSchemaZ.safeParse(record.schema);
  if (!parsedSchema.success) return { ok: false, error: "invalid_schema" };
  const schema = parsedSchema.data;
  if (schema.action?.id !== parsed.actionId) return { ok: false, error: "unknown_action" };

  const surface = await deps.loadSurface({
    interactionId: parsed.interactionId,
    surfaceId: parsed.surfaceId,
  });
  if (!surface) return { ok: false, error: "unknown_surface" };

  // A click rendered from an older draft must not act on the current one.
  if (parsed.revision !== record.draftVersion) {
    return { ok: false, error: "stale_revision" };
  }

  const key = clickKey(parsed);
  const prior = executed.get(key);
  if (prior === "done") return { ok: true, duplicate: true };
  if (prior === "in_flight") return { ok: true, duplicate: true };

  executed.set(key, "in_flight");
  let outcome: { ok: true } | { ok: false; error: string };
  try {
    outcome = await deps.runAction({
      interactionId: parsed.interactionId,
      actionId: parsed.actionId,
      revision: parsed.revision,
      record,
    });
  } catch {
    // An unexpected throw must not leave the click looking executed.
    executed.delete(key);
    return { ok: false, error: "action_failed" };
  }
  if (outcome.ok) {
    executed.set(key, "done");
    return { ok: true };
  }
  executed.delete(key);
  return { ok: false, error: outcome.error };
}
