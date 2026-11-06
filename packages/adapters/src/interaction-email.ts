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
  | { ok: false; error: string; outcome?: "failed" | "unknown" };

export type InteractionEmailInspect =
  | { found: true; deliveryId: string }
  | { found: false }
  | { found: false; outcome: "unknown"; error: string };

export const INTERACTION_EMAIL_SEND_TOOL = "GMAIL_SEND_EMAIL";
export const INTERACTION_EMAIL_INSPECT_TOOL = "GMAIL_FETCH_EMAILS";

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
  const result = await session.execute(INTERACTION_EMAIL_SEND_TOOL, {
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
      tool: INTERACTION_EMAIL_SEND_TOOL,
      args: {
        recipient_email: draft.to,
        subject: draft.subject,
        body: draft.body,
      },
      executionId: draft.idempotencyKey,
      ...(sender.connectionId ? { connectionId: sender.connectionId } : {}),
      route: { connectorId: "composio", toolName: INTERACTION_EMAIL_SEND_TOOL },
    },
    sender.context,
  ) as AsyncIterable<ConnectorEvent>) {
    if (event.type === "error") lastError = event.message;
    if (event.type === "result") lastResult = event.data;
  }
  if (lastError) return { ok: false, error: lastError || "Could not send the email" };
  if (lastResult === undefined) {
    return { ok: false, error: "Could not send the email", outcome: "unknown" };
  }
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

function inspectQuery(draft: InteractionEmailDraft): string {
  const to = draft.to.trim();
  const subject = draft.subject.trim();
  const parts = ["label:SENT"];
  if (to) parts.push(`to:${to}`);
  if (subject) parts.push(`subject:${subject.replace(/\s+/g, " ")}`);
  return parts.join(" ");
}

function messagesFromInspectResult(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : record;
  const messages = nested.messages ?? record.messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function matchingDeliveryId(
  draft: InteractionEmailDraft,
  messages: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  const to = draft.to.trim().toLowerCase();
  const subject = draft.subject.trim().toLowerCase();
  const body = draft.body.trim();
  const matched = messages.filter((message) => {
    const messageTo = typeof message.to === "string" ? message.to.toLowerCase() : "";
    const messageSubject = typeof message.subject === "string" ? message.subject.toLowerCase() : "";
    if (to && messageTo && messageTo !== to) return false;
    if (subject && messageSubject && messageSubject !== subject) return false;
    if (body) {
      const text =
        (typeof message.messageText === "string" && message.messageText) ||
        (typeof message.snippet === "string" && message.snippet) ||
        "";
      if (text && !text.includes(body.slice(0, 40))) return false;
    }
    return Boolean(message.messageId ?? message.id);
  });
  const chosen = matched.at(-1);
  const id = chosen?.messageId ?? chosen?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function inspectFailure(error: string): InteractionEmailInspect {
  const lower = error.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("aborted") ||
    lower.includes("uncertain") ||
    lower.includes("ambiguous")
  ) {
    return { found: false, outcome: "unknown", error };
  }
  return { found: false };
}

async function inspectViaClient(
  draft: InteractionEmailDraft,
  sender: Extract<InteractionEmailSender, { kind: "client" }>,
): Promise<InteractionEmailInspect> {
  const session = await sender.client.create(sender.userId, {
    toolkits: ["gmail"],
    manageConnections: false,
    sandbox: { enable: false },
  });
  const result = await session.execute(INTERACTION_EMAIL_INSPECT_TOOL, {
    query: inspectQuery(draft),
    max_results: 20,
    label_ids: ["SENT"],
  });
  if (result.error) return inspectFailure(result.error);
  const deliveryId = matchingDeliveryId(draft, messagesFromInspectResult(result.data));
  return deliveryId ? { found: true, deliveryId } : { found: false };
}

async function inspectViaConnector(
  draft: InteractionEmailDraft,
  sender: Extract<InteractionEmailSender, { kind: "connector" }>,
): Promise<InteractionEmailInspect> {
  let lastError: string | undefined;
  let lastResult: unknown;
  for await (const event of sender.connector.execute(
    {
      tool: INTERACTION_EMAIL_INSPECT_TOOL,
      args: {
        query: inspectQuery(draft),
        max_results: 20,
        label_ids: ["SENT"],
      },
      executionId: `${draft.idempotencyKey}:inspect`,
      ...(sender.connectionId ? { connectionId: sender.connectionId } : {}),
      route: { connectorId: "composio", toolName: INTERACTION_EMAIL_INSPECT_TOOL },
    },
    sender.context,
  ) as AsyncIterable<ConnectorEvent>) {
    if (event.type === "error") lastError = event.message;
    if (event.type === "result") lastResult = event.data;
  }
  if (lastError) return inspectFailure(lastError);
  if (lastResult === undefined) {
    return { found: false, outcome: "unknown", error: "Could not check send status" };
  }
  const deliveryId = matchingDeliveryId(draft, messagesFromInspectResult(lastResult));
  return deliveryId ? { found: true, deliveryId } : { found: false };
}

/**
 * Look up whether a confirmed draft already landed in SENT.
 * Callers must not treat this as a send: it never invokes the send tool.
 */
export async function inspectInteractionEmailDelivery(
  draft: InteractionEmailDraft,
  sender: InteractionEmailSender,
): Promise<InteractionEmailInspect> {
  const to = draft.to.trim();
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!to) return { found: false };
  const nextDraft = { ...draft, to, subject, body };
  if (sender.kind === "client") return inspectViaClient(nextDraft, sender);
  return inspectViaConnector(nextDraft, sender);
}
