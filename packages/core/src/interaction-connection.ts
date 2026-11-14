import { featuredConnectorProvidersMatch } from "./featured-connectors.js";
import { canonicalIntent, findInteractionCapability } from "./interaction-capability.js";
import { isEmailMailboxProvider } from "./interaction-preflight.js";

/** External app an interaction cannot act without. Provider-neutral ids. */
export type InteractionRequiredApp = "email" | "calendar";

/** Which app an intent acts through. Undefined intents need no connection. */
export function interactionRequiredApp(
  intent: string | undefined,
): InteractionRequiredApp | undefined {
  if (!intent) return undefined;
  return findInteractionCapability(canonicalIntent(intent))?.requiresConnection ?? undefined;
}

/** Whether a connected row's provider is the app, however the connector names it. */
export function connectionSatisfiesApp(app: InteractionRequiredApp, provider: string): boolean {
  if (app === "email") return isEmailMailboxProvider(provider);
  return featuredConnectorProvidersMatch(provider, "google-calendar");
}

/** Provider slug from a L0-A connect intent (`connect.gmail` / `connect.gmail.ca_1`). */
export function providerFromConnectIntent(intent: string): string | undefined {
  if (!intent.startsWith("connect.")) return undefined;
  return intent.slice("connect.".length).split(".")[0] || undefined;
}

/** Named account from `connect.{provider}.{accountId}`, when present. */
export function accountIdFromConnectIntent(intent: string): string | undefined {
  if (!intent.startsWith("connect.")) return undefined;
  const rest = intent.slice("connect.".length);
  const dot = rest.indexOf(".");
  if (dot < 0) return undefined;
  const accountId = rest.slice(dot + 1).trim();
  return accountId || undefined;
}

export function connectIntentMatchesApp(intent: string, app: InteractionRequiredApp): boolean {
  const provider = providerFromConnectIntent(intent);
  return Boolean(provider && connectionSatisfiesApp(app, provider));
}

/**
 * The open connection card that belongs to this app or named account.
 *
 * Rows must already be newest-first. Matching is by app (and account when
 * named), never "the newest needs_connection row in the thread".
 */
export function pickMatchingConnectionCard<T extends { intent: string; status?: string }>(
  rows: readonly T[],
  input: {
    app?: InteractionRequiredApp;
    provider?: string;
    intent?: string;
    accountId?: string;
  },
): T | undefined {
  const candidates = rows.filter((row) => {
    if (row.status && row.status !== "needs_connection") return false;
    if (
      input.intent &&
      (row.intent === input.intent || row.intent.startsWith(`${input.intent}.`))
    ) {
      return true;
    }
    if (input.app && connectIntentMatchesApp(row.intent, input.app)) return true;
    if (input.provider) {
      const provider = providerFromConnectIntent(row.intent);
      if (provider && featuredConnectorProvidersMatch(provider, input.provider)) return true;
      if (
        interactionResumesWhenConnected({
          intent: row.intent,
          interactionStatus: row.status ?? "needs_connection",
          provider: input.provider,
        })
      ) {
        return true;
      }
    }
    return false;
  });
  if (input.accountId) {
    const named = candidates.filter(
      (row) => accountIdFromConnectIntent(row.intent) === input.accountId,
    );
    if (named.length) return named[0];
  }
  return candidates[0];
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
