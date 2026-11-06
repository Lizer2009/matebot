import { featuredConnectorProvidersMatch } from "./featured-connectors.js";
import { isEmailMailboxProvider } from "./interaction-preflight.js";

/** External app an interaction cannot act without. Provider-neutral ids. */
export type InteractionRequiredApp = "email" | "calendar";

const CALENDAR_INTENTS: ReadonlySet<string> = new Set(["calendar.create", "calendar.compose"]);

/** Which app an intent acts through. Undefined intents need no connection. */
export function interactionRequiredApp(
  intent: string | undefined,
): InteractionRequiredApp | undefined {
  if (!intent) return undefined;
  if (intent === "email.compose" || intent === "email.send") return "email";
  if (CALENDAR_INTENTS.has(intent)) return "calendar";
  return undefined;
}

/** Whether a connected row's provider is the app, however the connector names it. */
export function connectionSatisfiesApp(app: InteractionRequiredApp, provider: string): boolean {
  if (app === "email") return isEmailMailboxProvider(provider);
  return featuredConnectorProvidersMatch(provider, "google-calendar");
}

/**
 * A surface resumes once its app connects: the plan waited on a connection and
 * the app that just connected is the one that plan acts through.
 */
export function interactionResumesWhenConnected(input: {
  intent: string | undefined;
  interactionStatus: string;
  provider: string;
}): boolean {
  if (input.interactionStatus !== "needs_connection") return false;
  const app = interactionRequiredApp(input.intent);
  return app !== undefined && connectionSatisfiesApp(app, input.provider);
}

/**
 * Provider text that means the saved authorization must be renewed rather than
 * retried or explained.
 */
const RECONNECT_SIGNALS = [
  "no longer active",
  "not active",
  "needs reconnect",
  "needs to reconnect",
  "must reconnect",
  "reconnect",
  "re-author",
  "reauthor",
  "invalid_grant",
  "token has been expired",
  "token expired",
  "access token expired",
  "refresh token",
  "revoked",
  "unauthorized",
  "not authorized",
  "insufficient authentication",
  "connection is not active",
  "account is inactive",
];

/** A delivery failure the user can only fix by reconnecting that app. */
export function deliveryNeedsReconnect(error: string | null | undefined): boolean {
  const text = error?.trim().toLowerCase() ?? "";
  if (!text) return false;
  return RECONNECT_SIGNALS.some((signal) => text.includes(signal));
}
