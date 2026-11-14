import { isCalendarCreateIntent } from "./interaction-capability.js";

/**
 * Copy shown while an A2UI surface is on screen. The card holds the fields and
 * the state, so the chat carries one line that points at it and nothing else:
 * no restated fields, no credential tutorial, no claim about the outcome.
 */
export type SurfaceNudgeState =
  /** A complete draft is on screen and has not been submitted. */
  | "presented"
  /** Required fields are still empty; the card is not a finished draft. */
  | "incomplete"
  /** The draft is waiting on an app connection before it can act. */
  | "awaiting_connection"
  /** The saved authorization died; only reconnecting fixes it. */
  | "reconnect";

/**
 * The only thing the model may say after publishing a surface. Kept as a
 * constant so prompts, tests, and hosts agree on one string per state.
 */
export const A2UI_SURFACE_NUDGE: Record<SurfaceNudgeState, string> = {
  presented: "请审阅后点发送，尚未发出。",
  incomplete: "请先补全收件人和主题。",
  awaiting_connection: "授权完成后点卡片继续。",
  reconnect: "连接已失效，请在卡片上重新授权。",
};

/** Calendar drafts are not mail. The button creates events; nothing has been written yet. */
export const CALENDAR_SURFACE_NUDGE = {
  presented: "请审阅后点创建，尚未写入日历。",
  incomplete: "请补全开始和结束时间。",
} as const;

/** Whether a surface of this state asks the user to authorize first. */
export function surfaceNudgeNeedsConnection(
  capability: "not_connected" | "requires_reauth" | "ready" | undefined,
): boolean {
  return capability === "not_connected" || capability === "requires_reauth";
}

const EMAIL_REQUIRED_GAPS = new Set(["to", "subject", "body"]);

/** Pick the one line that matches what the card is waiting for. */
export function surfaceNudgeFor(input: {
  capability?: "not_connected" | "requires_reauth" | "ready";
  lifecycle?: "draft" | "submitting" | "executing" | "succeeded" | "failed" | "unknown";
  /** Declared required fields still empty on the published card. */
  missingRequired?: readonly string[];
  intent?: string;
}): SurfaceNudgeState | undefined {
  if (input.lifecycle === "submitting" || input.lifecycle === "executing") return undefined;
  if (input.lifecycle === "succeeded" || input.lifecycle === "unknown") return undefined;
  if (input.lifecycle === "failed") {
    return input.capability === "requires_reauth" ? "reconnect" : undefined;
  }
  if (input.capability === "requires_reauth") return "reconnect";
  if (input.capability === "not_connected") return "awaiting_connection";
  const calendar = isCalendarCreateIntent(input.intent);
  if (
    input.missingRequired?.some((name) =>
      calendar
        ? name === "start" || name === "end" || name === "name"
        : EMAIL_REQUIRED_GAPS.has(name),
    )
  ) {
    return "incomplete";
  }
  return "presented";
}

/** The one line for this intent. Mail and calendar do not share a verb. */
export function surfaceNudgeText(input: { state: SurfaceNudgeState; intent?: string }): string {
  const calendar = isCalendarCreateIntent(input.intent);
  if (calendar && (input.state === "presented" || input.state === "incomplete")) {
    return CALENDAR_SURFACE_NUDGE[input.state];
  }
  return A2UI_SURFACE_NUDGE[input.state];
}
