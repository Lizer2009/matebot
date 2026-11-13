import { InteractionNotFoundError } from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionRetryRejectedError, retryInteractionService } from "./interaction-retry.js";

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    appendEventInTransaction: vi.fn(async () => ({ id: "event-1", seq: 1 })),
    withTransactionRetry: async (fn: () => Promise<unknown>) => fn(),
  };
});

const plan = {
  intent: "email.compose",
  title: "Send email",
  fields: [],
  nextStep: "render" as const,
  riskLevel: "low" as const,
};

const input = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  interactionId: "ix-1",
};

function fixture(options: { status: string; updateCount?: number; missing?: boolean }) {
  const block = {
    kind: "a2ui_surface" as const,
    interactionId: "ix-1",
    surfaceId: "surf-1",
    protocolFamily: "v0_9" as const,
    draftVersion: 3,
    intent: "email.compose",
    title: "Send email",
    status: options.status,
    lifecycle: "draft" as const,
    template: "action-expired-card",
  };
  const message = { id: "msg-1", blocks: [block] };
  const row = options.missing
    ? null
    : {
        id: "ix-1",
        spaceId: "space-1",
        threadId: "thread-1",
        runId: null,
        intent: "email.compose",
        status: options.status,
        cardKey: "key-1",
        staleAt: null,
        expiresAt: null,
        draftVersion: 3,
        confirmedVersion: null,
        plan,
        slots: {},
        title: "Send email",
        summary: null,
        approvalEffectId: null,
        messageId: "msg-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
  const prisma = {
    interaction: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: options.updateCount ?? 1 })),
    },
    interactionSurface: {
      findFirst: vi.fn(async () =>
        row
          ? { id: "surf-row", surfaceId: "surf-1", protocolFamily: "v0_9", draftVersion: 3 }
          : null,
      ),
      update: vi.fn(async () => undefined),
    },
    message: {
      findUnique: vi.fn(async () => message),
      update: vi.fn(async ({ data }: { data: { blocks: unknown[] } }) => {
        message.blocks = data.blocks as typeof message.blocks;
        return message;
      }),
    },
    interactionEvent: { create: vi.fn(async () => ({ id: "ev-1" })) },
    $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { prisma, message };
}

describe("retryInteractionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revives the row and rewrites the same surface in place", async () => {
    const { prisma, message } = fixture({ status: "expired" });
    const result = await retryInteractionService(prisma as never, input);
    expect(result).toMatchObject({
      interactionId: "ix-1",
      surfaceId: "surf-1",
      draftVersion: 4,
    });
    expect(["collecting", "ready_for_review"]).toContain(result.status);
    expect(message.blocks).toHaveLength(1);
    expect(message.blocks[0]).toMatchObject({
      kind: "a2ui_surface",
      interactionId: "ix-1",
      surfaceId: "surf-1",
      draftVersion: 4,
      status: result.status,
    });
    expect(prisma.interaction.updateMany).toHaveBeenCalledTimes(1);
  });

  it("answers a conflict when the card moved meanwhile", async () => {
    const { prisma, message } = fixture({ status: "failed", updateCount: 0 });
    await expect(retryInteractionService(prisma as never, input)).rejects.toBeInstanceOf(
      InteractionRetryRejectedError,
    );
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(message.blocks[0]?.status).toBe("failed");
  });

  it("refuses a card that may not come back", async () => {
    const { prisma } = fixture({ status: "superseded" });
    await expect(retryInteractionService(prisma as never, input)).rejects.toMatchObject({
      name: "InteractionRetryRejectedError",
      code: "not_revivable",
    });
    expect(prisma.interaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it("answers not found when the row is missing", async () => {
    const { prisma } = fixture({ status: "expired", missing: true });
    await expect(retryInteractionService(prisma as never, input)).rejects.toBeInstanceOf(
      InteractionNotFoundError,
    );
  });
});
