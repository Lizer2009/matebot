import { describe, expect, it } from "vitest";
import { FakeComposioClient } from "./composio-fake.js";
import { deliverInteractionEmail } from "./interaction-email.js";

describe("deliverInteractionEmail", () => {
  it("sends the confirmed draft through the offline mailbox", async () => {
    const client = new FakeComposioClient();
    const result = await deliverInteractionEmail(
      {
        to: "a@example.com",
        subject: "Hi",
        body: "Hello",
        idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      },
      client,
    );
    expect(result).toMatchObject({ ok: true, deliveryId: "18c5f5e1" });
    expect(client.executions).toEqual([
      expect.objectContaining({
        tool: "GMAIL_SEND_EMAIL",
        args: { recipient_email: "a@example.com", subject: "Hi", body: "Hello" },
      }),
    ]);
    const sent = client
      .mailboxFor("interaction-email")
      ?.messages.find((message) => message.to === "a@example.com");
    expect(sent).toMatchObject({ subject: "Hi", messageText: "Hello", labelIds: ["SENT"] });
  });

  it("rejects a draft that has no recipient", async () => {
    const client = new FakeComposioClient();
    await expect(
      deliverInteractionEmail(
        { to: "  ", subject: "Hi", body: "Hello", idempotencyKey: "key" },
        client,
      ),
    ).resolves.toEqual({ ok: false, error: "A recipient is required" });
    expect(client.executions).toHaveLength(0);
  });
});
