import { featuredConnectorProvidersMatch } from "./featured-connectors.js";
import type { InteractionLifecycleStatus } from "./interaction-runtime.js";

/** Capability preflight for a bound app. Not a boolean isBound. */
export type EmailPreflightStatus = "NOT_CONNECTED" | "REQUIRES_REAUTH" | "CONNECTED_AND_READY";

/** Timeline stamp on `a2ui_surface`. Omitted on old events means ready. */
export type EmailSurfaceCapability = "not_connected" | "requires_reauth" | "ready";

export type EmailConnectionSnapshot = {
  provider: string;
  status: string;
  providerRef?: string | null;
};

export function isEmailMailboxProvider(provider: string): boolean {
  return featuredConnectorProvidersMatch(provider, "gmail");
}

export function emailCapabilityToSurface(status: EmailPreflightStatus): EmailSurfaceCapability {
  if (status === "CONNECTED_AND_READY") return "ready";
  if (status === "REQUIRES_REAUTH") return "requires_reauth";
  return "not_connected";
}

export function emailCapabilityAllowsSend(status: EmailPreflightStatus): boolean {
  return status === "CONNECTED_AND_READY";
}

function refSet(refs: readonly string[] | undefined): Set<string> {
  return new Set((refs ?? []).map((ref) => ref.trim()).filter(Boolean));
}

function isReconnecting(row: EmailConnectionSnapshot, reconnect: Set<string>): boolean {
  const ref = row.providerRef?.trim();
  return Boolean(ref && reconnect.has(ref));
}

export type AppPreflightInput = {
  connections: readonly EmailConnectionSnapshot[];
  /** Provider refs the connector reports as dead until the user reconnects. */
  reconnectRefs?: readonly string[];
  /**
   * Whether the connector still accepts each provider slug, keyed like the
   * stored rows. A local row can say `connected` long after the provider
   * revoked the account, so the provider's own health wins. A missing entry
   * means the connector could not answer and the local status stands.
   */
  providerReady?: Readonly<Record<string, boolean>>;
};

export type AppPreflightResult = {
  status: EmailPreflightStatus;
  interactionStatus: Extract<InteractionLifecycleStatus, "needs_connection"> | null;
  surfaceCapability: EmailSurfaceCapability;
};

function providerState(
  row: EmailConnectionSnapshot,
  providerReady: Readonly<Record<string, boolean>> | undefined,
): "ready" | "dead" | "unknown" {
  if (!providerReady) return "unknown";
  const own = providerReady[row.provider] ?? providerReady[row.provider.trim().toLowerCase()];
  if (own === undefined) return "unknown";
  return own ? "ready" : "dead";
}

function preflight(
  rows: readonly EmailConnectionSnapshot[],
  reconnectRefs: readonly string[] | undefined,
  providerReady: Readonly<Record<string, boolean>> | undefined,
): AppPreflightResult {
  const reconnect = refSet(reconnectRefs);
  const connected = rows.filter((row) => row.status === "connected");
  if (
    connected.some(
      (row) => !isReconnecting(row, reconnect) && providerState(row, providerReady) !== "dead",
    )
  ) {
    return {
      status: "CONNECTED_AND_READY",
      interactionStatus: null,
      surfaceCapability: "ready",
    };
  }
  const needsReauth = rows.some((row) => row.status === "error" || isReconnecting(row, reconnect));
  if (needsReauth || connected.length > 0) {
    return {
      status: "REQUIRES_REAUTH",
      interactionStatus: "needs_connection",
      surfaceCapability: "requires_reauth",
    };
  }
  return {
    status: "NOT_CONNECTED",
    interactionStatus: "needs_connection",
    surfaceCapability: "not_connected",
  };
}

/** Map Connection rows + connector health onto the three-state for a mailbox. */
export function preflightEmailCapability(input: AppPreflightInput): AppPreflightResult {
  return preflight(
    input.connections.filter((row) => isEmailMailboxProvider(row.provider)),
    input.reconnectRefs,
    input.providerReady,
  );
}

/** Same three-state for a calendar Connection. */
export function preflightCalendarCapability(input: AppPreflightInput): AppPreflightResult {
  return preflight(
    input.connections.filter((row) =>
      featuredConnectorProvidersMatch(row.provider, "google-calendar"),
    ),
    input.reconnectRefs,
    input.providerReady,
  );
}

function selectUsable<T extends EmailConnectionSnapshot>(
  matches: (row: T) => boolean,
  connections: readonly T[],
  reconnectRefs: readonly string[] | undefined,
  providerReady: Readonly<Record<string, boolean>> | undefined,
): T | undefined {
  const reconnect = refSet(reconnectRefs);
  return connections.find(
    (row) =>
      matches(row) &&
      row.status === "connected" &&
      !isReconnecting(row, reconnect) &&
      providerState(row, providerReady) !== "dead",
  );
}

export function selectEmailSendConnection<T extends EmailConnectionSnapshot>(
  connections: readonly T[],
  reconnectRefs?: readonly string[],
  providerReady?: Readonly<Record<string, boolean>>,
): T | undefined {
  return selectUsable(
    (row) => isEmailMailboxProvider(row.provider),
    connections,
    reconnectRefs,
    providerReady,
  );
}

export function selectCalendarConnection<T extends EmailConnectionSnapshot>(
  connections: readonly T[],
  reconnectRefs?: readonly string[],
  providerReady?: Readonly<Record<string, boolean>>,
): T | undefined {
  return selectUsable(
    (row) => featuredConnectorProvidersMatch(row.provider, "google-calendar"),
    connections,
    reconnectRefs,
    providerReady,
  );
}
