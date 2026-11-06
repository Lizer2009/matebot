import type { A2uiActionPayload } from "./load-a2ui";

/** The action prefix the trusted compiler emits. Kept in sync with the adapter. */
const ACTION_PREFIX = "interaction.action.";

export type ParsedSurfaceAction = {
  action: string;
  interactionId: string;
  revision: number;
};

/**
 * Read what the surface sent. Values arrive already resolved from the data
 * model, so a binding that failed to resolve appears as an object and is
 * rejected here rather than being sent to the server as `[object Object]`.
 */
export function parseSurfaceAction(payload: A2uiActionPayload): ParsedSurfaceAction | null {
  if (typeof payload.name !== "string" || !payload.name.startsWith(ACTION_PREFIX)) return null;
  const action = payload.name.slice(ACTION_PREFIX.length).trim();
  if (!action || action.includes(".")) return null;

  const context = payload.context ?? {};
  const interactionId = context.interactionId;
  const revision = context.revision;
  if (typeof interactionId !== "string" || !interactionId.trim()) return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;

  return { action, interactionId: interactionId.trim(), revision };
}
