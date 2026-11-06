import { featuredConnectorProvidersMatch } from "./featured-connectors.js";
import type { InteractionLifecycleStatus } from "./interaction-runtime.js";

/** Capability preflight for mailbox send. Not a boolean isBound. */
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

function reconnectSet(refs: readonly string[] | undefined): Set<string> {
  return new Set((refs ?? []).map((ref) => ref.trim()).filter(Boolean));
}

function isReconnecting(row: EmailConnectionSnapshot, reconnect: Set<string>): boolean {
  const ref = row.providerRef?.trim();
  return Boolean(ref && reconnect.has(ref));
}

/** Map Connection rows + connector reconnect refs onto the three-state. */
export function preflightEmailCapability(input: {
  connections: readonly EmailConnectionSnapshot[];
  reconnectRefs?: readonly string[];
}): {
  status: EmailPreflightStatus;
  interactionStatus: Extract<InteractionLifecycleStatus, "needs_connection"> | null;
  surfaceCapability: EmailSurfaceCapability;
} {
  const reconnect = reconnectSet(input.reconnectRefs);
  const emailRows = input.connections.filter((row) => isEmailMailboxProvider(row.provider));
  const ready = emailRows.filter(
    (row) => row.status === "connected" && !isReconnecting(row, reconnect),
  );
  if (ready.length > 0) {
    return {
      status: "CONNECTED_AND_READY",
      interactionStatus: null,
      surfaceCapability: "ready",
    };
  }
  const needsReauth = emailRows.some(
    (row) => row.status === "error" || isReconnecting(row, reconnect),
  );
  if (needsReauth) {
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

export function selectEmailSendConnection<T extends EmailConnectionSnapshot>(
  connections: readonly T[],
  reconnectRefs?: readonly string[],
): T | undefined {
  const reconnect = reconnectSet(reconnectRefs);
  return connections.find(
    (row) =>
      isEmailMailboxProvider(row.provider) &&
      row.status === "connected" &&
      !isReconnecting(row, reconnect),
  );
}
