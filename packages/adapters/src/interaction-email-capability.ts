import type { AdapterContext, ManagedConnectorProvider } from "@matebot/adapter-kit";
import type {
  EmailConnectionSnapshot,
  EmailPreflightStatus,
  EmailSurfaceCapability,
} from "@matebot/core";
import {
  connectionSatisfiesApp,
  interactionRequiredApp,
  preflightCalendarCapability,
  preflightEmailCapability,
  selectCalendarConnection,
  selectEmailSendConnection,
} from "@matebot/core";
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

/**
 * Ask the connector whether each stored provider still works. A local row keeps
 * `connected` after the provider revokes the account, so the provider's own
 * answer decides. Providers that cannot answer are left out, not assumed dead.
 */
export async function loadProviderReadiness(
  provider:
    | { connectionReady?(context: AdapterContext, externalId: string): Promise<boolean> }
    | undefined,
  context: AdapterContext,
  rows: readonly EmailCapabilityRow[],
): Promise<Record<string, boolean>> {
  const ready = provider?.connectionReady;
  if (!ready) return {};
  const slugs = [
    ...new Set(rows.filter((row) => row.status === "connected").map((r) => r.provider)),
  ];
  const answers = await Promise.all(
    slugs.map(async (slug) => {
      try {
        return [slug, await ready.call(provider, context, slug)] as const;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(answers.filter((entry) => entry !== null));
}

export function emailCapabilityFromRows(
  connections: EmailCapabilityRow[],
  reconnectRefs: readonly string[] = [],
  providerReady?: Readonly<Record<string, boolean>>,
): EmailCapabilitySnapshot {
  const preflight = preflightEmailCapability({ connections, reconnectRefs, providerReady });
  return {
    status: preflight.status,
    surfaceCapability: preflight.surfaceCapability,
    interactionNeedsConnection: preflight.interactionStatus === "needs_connection",
    connection: selectEmailSendConnection(connections, reconnectRefs, providerReady),
    connections,
    reconnectRefs: [...reconnectRefs],
  };
}

/** Three-state preflight for any app an interaction acts through. */
export function interactionCapabilityFromRows(
  intent: string | undefined,
  connections: EmailCapabilityRow[],
  reconnectRefs: readonly string[] = [],
  providerReady?: Readonly<Record<string, boolean>>,
): {
  status: EmailPreflightStatus;
  surfaceCapability: EmailSurfaceCapability;
  interactionNeedsConnection: boolean;
  connection: EmailCapabilityRow | undefined;
} {
  const app = interactionRequiredApp(intent);
  const preflight =
    app === "calendar"
      ? preflightCalendarCapability({ connections, reconnectRefs, providerReady })
      : preflightEmailCapability({ connections, reconnectRefs, providerReady });
  const connection =
    app === "calendar"
      ? selectCalendarConnection(connections, reconnectRefs, providerReady)
      : selectEmailSendConnection(connections, reconnectRefs, providerReady);
  return {
    status: preflight.status,
    surfaceCapability: preflight.surfaceCapability,
    interactionNeedsConnection: preflight.interactionStatus === "needs_connection",
    connection,
  };
}

/** Whether a freshly connected provider is the app this interaction waited on. */
export function providerSatisfiesInteractionApp(
  intent: string | undefined,
  provider: string,
): boolean {
  const app = interactionRequiredApp(intent);
  return app !== undefined && connectionSatisfiesApp(app, provider);
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
