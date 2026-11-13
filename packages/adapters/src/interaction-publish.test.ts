import type { InteractionPlan } from "@matebot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const compileInteractionPlan = vi.fn();
vi.mock("@matebot/a2ui-adapter", async () => {
  const actual =
    await vi.importActual<typeof import("@matebot/a2ui-adapter")>("@matebot/a2ui-adapter");
  return {
    compileInteractionPlan: (...args: unknown[]) => compileInteractionPlan(...args),
    // Reconciliation runs for real: these tests assert on the row that gets stored.
    reconcilePlanToSchema: actual.reconcilePlanToSchema,
  };
});

const createInteraction = vi.fn();
const upsertInteractionSurface = vi.fn();
const createThreadMessageInTransaction = vi.fn();
const appendEventInTransaction = vi.fn();
const appendInteractionEvent = vi.fn();
vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    createInteraction: (...args: unknown[]) => createInteraction(...args),
    upsertInteractionSurface: (...args: unknown[]) => upsertInteractionSurface(...args),
    createThreadMessageInTransaction: (...args: unknown[]) =>
      createThreadMessageInTransaction(...args),
    appendEventInTransaction: (...args: unknown[]) => appendEventInTransaction(...args),
    appendInteractionEvent: (...args: unknown[]) => appendInteractionEvent(...args),
    withTransactionRetry: async (work: () => Promise<unknown>) => work(),
  };
});

const { publishInteractionSurface } = await import("./interaction-publish.js");

const plan: InteractionPlan = {
  intent: "email.compose",
  title: "Send email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved" },
    { name: "subject", value: "Hi", required: true, status: "resolved" },
    { name: "body", value: "Hello", required: true, status: "resolved" },
  ],
  nextStep: "ask",
  riskLevel: "medium",
};

describe("publishInteractionSurface", () => {
  beforeEach(() => {
    compileInteractionPlan.mockReset();
    createInteraction.mockReset();
    upsertInteractionSurface.mockReset();
    createThreadMessageInTransaction.mockReset();
    appendEventInTransaction.mockReset();
    appendInteractionEvent.mockReset();

    compileInteractionPlan.mockResolvedValue({
      ok: true,
      protocolFamily: "v0_9",
      surfaceId: "surface-1",
      messages: [{ version: "v0.9", createSurface: { surfaceId: "surface-1" } }],
    });
    createInteraction.mockResolvedValue({
      id: "ix-1",
      intent: "email.compose",
      draftVersion: 1,
      title: "Send email",
      summary: null,
    });
    upsertInteractionSurface.mockResolvedValue({
      documentRef: "a2ui:interaction:ix-1:surface:surface-1",
    });
    createThreadMessageInTransaction.mockResolvedValue({ id: "msg-1" });
    appendEventInTransaction.mockResolvedValue({ id: "event-1", seq: 3 });
  });

  it("creates interaction, surface message, and product events", async () => {
    const interactionUpdate = vi.fn(async () => ({ id: "ix-1" }));
    const prisma = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          interaction: { update: interactionUpdate },
        }),
    };

    const result = await publishInteractionSurface(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      plan,
      surfaceId: "surface-1",
    });

    // The compiler is handed the reconciled plan: the schema's fields in its order, so the row
    // and the card describe the same set. `cc` is declared but was absent from the model's plan.
    expect(compileInteractionPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          intent: "email.compose",
          fields: [
            expect.objectContaining({ name: "to", value: "a@example.com" }),
            expect.objectContaining({ name: "cc", required: false }),
            expect.objectContaining({ name: "subject", value: "Hi" }),
            expect.objectContaining({ name: "body", value: "Hello" }),
          ],
        }),
        surfaceId: "surface-1",
      }),
    );
    expect(createInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ intent: "email.compose", runId: "run-1" }),
    );
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "bot",
        blocks: [
          expect.objectContaining({
            kind: "a2ui_surface",
            intent: "email.compose",
            interactionId: "ix-1",
          }),
        ],
      }),
    );
    expect(appendEventInTransaction).toHaveBeenCalledTimes(3);
    expect(appendInteractionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        interactionId: "ix-1",
        kind: "published",
        toStatus: "collecting",
      }),
    );
    expect(result).toMatchObject({
      interactionId: "ix-1",
      surfaceId: "surface-1",
      messageId: "msg-1",
      draftVersion: 1,
      eventSeq: 3,
    });
  });

  it("stamps mailbox capability and needs_connection on an unbound email draft", async () => {
    const interactionUpdate = vi.fn(async () => ({ id: "ix-1" }));
    const prisma = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          interaction: { update: interactionUpdate },
        }),
    };

    await publishInteractionSurface(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan,
      surfaceId: "surface-1",
      capability: "not_connected",
      status: "needs_connection",
    });

    expect(createInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "needs_connection" }),
    );
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            capability: "not_connected",
            template: "email-connection-card",
            lifecycle: "draft",
            historySlots: { to: "a@example.com", subject: "Hi" },
          }),
        ],
      }),
    );
  });

  it("stores the resume plan on a needs_connection card so reconnect can restore slots", async () => {
    const interactionUpdate = vi.fn(async () => ({ id: "ix-1" }));
    const prisma = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          interaction: { update: interactionUpdate },
        }),
    };

    await publishInteractionSurface(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan,
      surfaceId: "surface-1",
      capability: "not_connected",
      status: "needs_connection",
      resumePlan: {
        provider: "gmail",
        accountId: "conn-keep",
        displayEmail: "keep@example.test",
        intent: "email.compose",
        slots: { to: "friend@example.test", subject: "冬天的问候" },
      },
    });

    expect(createInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "needs_connection",
        plan: expect.objectContaining({
          resumePlan: {
            provider: "gmail",
            accountId: "conn-keep",
            displayEmail: "keep@example.test",
            intent: "email.compose",
            slots: { to: "friend@example.test", subject: "冬天的问候" },
          },
        }),
      }),
    );
  });
});
