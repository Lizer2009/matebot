import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@matebot/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeComposioClient } from "./composio-fake.js";
import { deliverInteractionEmail } from "./interaction-email.js";

const draft = {
  to: "a@example.com",
  subject: "Hi",
  body: "Hello",
  idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
};

describe("deliverInteractionEmail", () => {
  it("sends the confirmed draft through an injected client for the actor user", async () => {
    const client = new FakeComposioClient();
    client.connect("user-1", "gmail");
    const result = await deliverInteractionEmail(draft, {
      kind: "client",
      userId: "user-1",
      client,
    });
    expect(result).toMatchObject({ ok: true, deliveryId: "18c5f5e1" });
    expect(client.executions).toEqual([
      expect.objectContaining({
        userId: "user-1",
        tool: "GMAIL_SEND_EMAIL",
        args: { recipient_email: "a@example.com", subject: "Hi", body: "Hello" },
      }),
    ]);
    expect(client.mailboxFor("interaction-email")).toBeUndefined();
    const sent = client
      .mailboxFor("user-1")
      ?.messages.find((message) => message.to === "a@example.com");
    expect(sent).toMatchObject({ subject: "Hi", messageText: "Hello", labelIds: ["SENT"] });
  });

  it("sends through an injected connector instead of constructing Fake", async () => {
    const events: ConnectorEvent[] = [{ type: "result", data: { data: { messageId: "prov-99" } } }];
    const connector: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield* events;
      },
    };
    const context = {
      operationId: "interaction.email.send",
      traceId: "interaction.email.send",
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    const result = await deliverInteractionEmail(draft, {
      kind: "connector",
      context,
      connector,
      connectionId: "conn-gmail",
    });
    expect(result).toEqual({ ok: true, deliveryId: "prov-99" });
  });

  it("classifies a connector that never returns a result as UNKNOWN", async () => {
    const connector: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield { type: "log", message: "queued" };
      },
    };
    const context = {
      operationId: "interaction.email.send",
      traceId: "interaction.email.send",
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    await expect(
      deliverInteractionEmail(draft, {
        kind: "connector",
        context,
        connector,
        connectionId: "conn-gmail",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Could not send the email",
      outcome: "unknown",
    });
  });

  it("rejects a draft that has no recipient without calling the client", async () => {
    const client = new FakeComposioClient();
    await expect(
      deliverInteractionEmail(
        { to: "  ", subject: "Hi", body: "Hello", idempotencyKey: "key" },
        { kind: "client", userId: "user-1", client },
      ),
    ).resolves.toEqual({ ok: false, error: "A recipient is required" });
    expect(client.executions).toHaveLength(0);
  });
});
