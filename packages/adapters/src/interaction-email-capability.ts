import type { AdapterContext, ManagedConnectorProvider } from "@matebot/adapter-kit";
import type {
  EmailConnectionSnapshot,
  EmailPreflightStatus,
  EmailSurfaceCapability,
} from "@matebot/core";
import { preflightEmailCapability, selectEmailSendConnection } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { connectedContext } from "./connection-context.js";

export type EmailCapabilityRow = EmailConnectionSnapshot & {
  id: string;
  connectorId: string;
  displayName: string;
};

export type EmailCapabilitySnapshot = {
  status: EmailPreflightStatus;
  surfaceCapability: EmailSurfaceCapability;
  interactionNeedsConnection: boolean;
  connection: EmailCapabilityRow | undefined;
  connections: EmailCapabilityRow[];
  reconnectRefs: string[];
};

export async function loadOwnerEmailConnections(
  prisma: PrismaClient,
  owner: { spaceId: string; userId: string },
): Promise<EmailCapabilityRow[]> {
  const rows = await prisma.connection.findMany({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    select: {
      id: true,
      connectorId: true,
      provider: true,
      displayName: true,
      status: true,
      providerRef: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    connectorId: row.connectorId,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status,
    providerRef: row.providerRef,
  }));
}

export async function loadEmailReconnectRefs(
  listReconnectRefs: ManagedConnectorProvider["listReconnectRefs"] | undefined,
  context: AdapterContext,
): Promise<string[]> {
  if (!listReconnectRefs) return [];
  try {
    return await listReconnectRefs(context);
  } catch {
    return [];
  }
}

export function emailCapabilityFromRows(
  connections: EmailCapabilityRow[],
  reconnectRefs: readonly string[] = [],
): EmailCapabilitySnapshot {
  const preflight = preflightEmailCapability({ connections, reconnectRefs });
  return {
    status: preflight.status,
    surfaceCapability: preflight.surfaceCapability,
    interactionNeedsConnection: preflight.interactionStatus === "needs_connection",
    connection: selectEmailSendConnection(connections, reconnectRefs),
    connections,
    reconnectRefs: [...reconnectRefs],
  };
}

export function emailSendAdapterContext(
  owner: { spaceId: string; userId: string },
  connection: EmailCapabilityRow,
): AdapterContext {
  return {
    operationId: "interaction.email.send",
    traceId: "interaction.email.send",
    spaceId: owner.spaceId,
    userId: owner.userId,
    signal: new AbortController().signal,
    ...connectedContext([
      {
        id: connection.id,
        connectorId: connection.connectorId,
        provider: connection.provider,
        displayName: connection.displayName,
        providerRef: connection.providerRef ?? null,
      },
    ]),
  };
}
