import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@matebot/adapter-kit";
import type { ComposioClient } from "./composio-connector.js";

export type InteractionEmailDraft = {
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
};

export type InteractionEmailDelivery =
  | { ok: true; deliveryId: string }
  | { ok: false; error: string };

/** Injected sender. Tests pass Fake explicitly; production never default-constructs it. */
export type InteractionEmailSender =
  | { kind: "client"; userId: string; client: ComposioClient }
  | {
      kind: "connector";
      context: AdapterContext;
      connector: Pick<ConnectorProvider, "execute">;
      connectionId?: string;
    };

function deliveryIdFromUnknown(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const nested = record.data;
  const messageId =
    record.messageId ??
    record.id ??
    (nested && typeof nested === "object" && !Array.isArray(nested)
      ? ((nested as Record<string, unknown>).messageId ?? (nested as Record<string, unknown>).id)
      : undefined);
  return typeof messageId === "string" && messageId.trim() ? messageId.trim() : fallback;
}

async function executeViaClient(
  draft: InteractionEmailDraft,
  sender: Extract<InteractionEmailSender, { kind: "client" }>,
): Promise<InteractionEmailDelivery> {
  const session = await sender.client.create(sender.userId, {
    toolkits: ["gmail"],
    manageConnections: false,
    sandbox: { enable: false },
  });
  const result = await session.execute("GMAIL_SEND_EMAIL", {
    recipient_email: draft.to,
    subject: draft.subject,
    body: draft.body,
  });
  if (result.error) return { ok: false, error: "Could not send the email" };
  return { ok: true, deliveryId: deliveryIdFromUnknown(result.data, draft.idempotencyKey) };
}

async function executeViaConnector(
  draft: InteractionEmailDraft,
  sender: Extract<InteractionEmailSender, { kind: "connector" }>,
): Promise<InteractionEmailDelivery> {
  let lastError: string | undefined;
  let lastResult: unknown;
  for await (const event of sender.connector.execute(
    {
      tool: "GMAIL_SEND_EMAIL",
      args: {
        recipient_email: draft.to,
        subject: draft.subject,
        body: draft.body,
      },
      executionId: draft.idempotencyKey,
      ...(sender.connectionId ? { connectionId: sender.connectionId } : {}),
      route: { connectorId: "composio", toolName: "GMAIL_SEND_EMAIL" },
    },
    sender.context,
  ) as AsyncIterable<ConnectorEvent>) {
    if (event.type === "error") lastError = event.message;
    if (event.type === "result") lastResult = event.data;
  }
  if (lastError) return { ok: false, error: lastError || "Could not send the email" };
  if (lastResult === undefined) return { ok: false, error: "Could not send the email" };
  return { ok: true, deliveryId: deliveryIdFromUnknown(lastResult, draft.idempotencyKey) };
}

/**
 * Deliver a confirmed interaction email through the caller's bound mailbox.
 * Callers must inject a Composio client or connector; Fake is test-only.
 */
export async function deliverInteractionEmail(
  draft: InteractionEmailDraft,
  sender: InteractionEmailSender,
): Promise<InteractionEmailDelivery> {
  const to = draft.to.trim();
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!to) return { ok: false, error: "A recipient is required" };
  if (!subject && !body) return { ok: false, error: "A subject or message is required" };

  const nextDraft = { ...draft, to, subject, body };
  if (sender.kind === "client") return executeViaClient(nextDraft, sender);
  return executeViaConnector(nextDraft, sender);
}
