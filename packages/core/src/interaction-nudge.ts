/**
 * Copy shown while an A2UI surface is on screen. The card holds the fields and
 * the state, so the chat carries one line that points at it and nothing else:
 * no restated fields, no credential tutorial, no claim about the outcome.
 */
export type SurfaceNudgeState =
  /** A draft was just published and is waiting for the user. */
  | "presented"
  /** The draft is waiting on an app connection before it can act. */
  | "awaiting_connection"
  /** The saved authorization died; only reconnecting fixes it. */
  | "reconnect";

/**
 * The only thing the model may say after publishing a surface. Kept as a
 * constant so prompts, tests, and hosts agree on one string per state.
 */
export const A2UI_SURFACE_NUDGE: Record<SurfaceNudgeState, string> = {
  presented: "请在卡片上确认或编辑。",
  awaiting_connection: "授权完成后点卡片继续。",
  reconnect: "连接已失效，请在卡片上重新授权。",
};

/** Whether a surface of this state asks the user to authorize first. */
export function surfaceNudgeNeedsConnection(
  capability: "not_connected" | "requires_reauth" | "ready" | undefined,
): boolean {
  return capability === "not_connected" || capability === "requires_reauth";
}

/** Pick the one line that matches what the card is waiting for. */
export function surfaceNudgeFor(input: {
  capability?: "not_connected" | "requires_reauth" | "ready";
  lifecycle?: "draft" | "submitting" | "executing" | "succeeded" | "failed" | "unknown";
}): SurfaceNudgeState | undefined {
  if (input.lifecycle === "submitting" || input.lifecycle === "executing") return undefined;
  if (input.lifecycle === "succeeded" || input.lifecycle === "unknown") return undefined;
  if (input.lifecycle === "failed") {
    return input.capability === "requires_reauth" ? "reconnect" : undefined;
  }
  if (input.capability === "requires_reauth") return "reconnect";
  if (input.capability === "not_connected") return "awaiting_connection";
  return "presented";
}
