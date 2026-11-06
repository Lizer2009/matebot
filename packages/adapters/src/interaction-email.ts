import { FakeComposioClient } from "./composio-fake.js";

export type InteractionEmailDraft = {
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
};

export type InteractionEmailDelivery =
  | { ok: true; deliveryId: string }
  | { ok: false; error: string };

/**
 * Deliver a confirmed interaction email through the offline mailbox.
 * The tool slug stays in this adapter; callers pass slots only.
 */
export async function deliverInteractionEmail(
  draft: InteractionEmailDraft,
  client: FakeComposioClient = new FakeComposioClient(),
): Promise<InteractionEmailDelivery> {
  const to = draft.to.trim();
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!to) return { ok: false, error: "A recipient is required" };
  if (!subject && !body) return { ok: false, error: "A subject or message is required" };

  const userId = "interaction-email";
  client.connect(userId, "gmail");
  const session = await client.create(userId, { toolkits: ["gmail"] });
  const result = await session.execute("GMAIL_SEND_EMAIL", {
    recipient_email: to,
    subject,
    body,
  });
  if (result.error) return { ok: false, error: "Could not send the email" };
  const messageId = result.data.messageId;
  const deliveryId =
    typeof messageId === "string" && messageId.trim() ? messageId : draft.idempotencyKey;
  return { ok: true, deliveryId };
}
