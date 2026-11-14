import type { MessageBlock } from "@matebot/contracts";
import type * as db from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createInteraction = vi.fn();
const createThreadMessageInTransaction = vi.fn();
const appendEventInTransaction = vi.fn();
const appendInteractionEvent = vi.fn();
vi.mock("@matebot/db", async (original) => ({
  ...(await original<typeof db>()),
  createInteraction: (...args: unknown[]) => createInteraction(...args),
  createThreadMessageInTransaction: (...args: unknown[]) =>
    createThreadMessageInTransaction(...args),
  appendEventInTransaction: (...args: unknown[]) => appendEventInTransaction(...args),
  appendInteractionEvent: (...args: unknown[]) => appendInteractionEvent(...args),
  withTransactionRetry: async (work: () => Promise<unknown>) => work(),
}));

const findOpenCard = vi.fn();
const settleInteraction = vi.fn();
vi.mock("./interaction-kernel-store.js", async (original) => ({
  ...(await original<typeof import("./interaction-kernel-store.js")>()),
  findOpenCard: (...args: unknown[]) => findOpenCard(...args),
  settleInteraction: (...args: unknown[]) => settleInteraction(...args),
}));

const { publishL0aView } = await import("./interaction-l0a-publish.js");

const connectBlock: Extract<MessageBlock, { kind: "app_connect" }> = {
  kind: "app_connect",
  connectorId: "fake",
  provider: "gmail",
  name: "Gmail",
  description: "Search, read, draft, and send email.",
  logo: null,
  status: "pending",
};

function fixture() {
  const stored = {
    blocks: [] as MessageBlock[],
    draftVersion: 1,
    status: "needs_connection",
  };
  const interactionUpdate = vi.fn(async () => ({ id: "ix-1" }));
  const interactionUpdateMany = vi.fn(async () => ({ count: 1 }));
  const messageUpdate = vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
    stored.blocks = data.blocks;
    return { id: "msg-1" };
  });
  const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        $executeRaw: vi.fn(),
        interaction: {
          update: interactionUpdate,
          updateMany: interactionUpdateMany,
          findUnique: vi.fn(async () => ({
            status: stored.status,
            draftVersion: stored.draftVersion,
          })),
        },
        message: {
          findUnique: vi.fn(async () => ({ blocks: stored.blocks })),
          update: messageUpdate,
        },
      }),
  };
  return { prisma, stored, interactionUpdate, interactionUpdateMany, messageUpdate };
}

describe("publishL0aView", () => {
  beforeEach(() => {
    createInteraction.mockReset();
    createThreadMessageInTransaction.mockReset();
    appendEventInTransaction.mockReset();
    appendInteractionEvent.mockReset();
    findOpenCard.mockReset();
    settleInteraction.mockReset();
    createInteraction.mockResolvedValue({
      id: "ix-1",
      intent: "connect.gmail",
      draftVersion: 1,
      title: "Connect Gmail",
      summary: null,
    });
    createThreadMessageInTransaction.mockResolvedValue({ id: "msg-1" });
    appendEventInTransaction.mockResolvedValue({ id: "event-1", seq: 4 });
    appendInteractionEvent.mockResolvedValue(undefined);
    findOpenCard.mockResolvedValue(undefined);
  });

  it("creates an Interaction row and stamps the connect view without compiling A2UI", async () => {
    const { prisma, stored } = fixture();
    createThreadMessageInTransaction.mockImplementation(async (_tx, input) => {
      stored.blocks = input.blocks;
      return { id: "msg-1" };
    });

    const result = await publishL0aView(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      intent: "connect.gmail",
      title: "Connect Gmail",
      status: "needs_connection",
      block: connectBlock,
    });

    expect(createInteraction).toHaveBeenCalledTimes(1);
    expect(createInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        intent: "connect.gmail",
        status: "needs_connection",
        plan: expect.objectContaining({
          intent: "connect.gmail",
          fields: [],
          nextStep: "request_connection",
        }),
      }),
    );
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            kind: "app_connect",
            provider: "gmail",
            status: "pending",
            interactionId: "ix-1",
            cardStatus: "needs_connection",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      interactionId: "ix-1",
      messageId: "msg-1",
      amended: false,
      draftVersion: 1,
    });
    expect(settleInteraction).not.toHaveBeenCalled();
  });

  it("amends the same connect intent in place instead of stacking a second card", async () => {
    const { prisma, stored } = fixture();
    stored.blocks = [
      {
        ...connectBlock,
        interactionId: "ix-1",
        cardStatus: "needs_connection",
      },
    ];
    findOpenCard.mockResolvedValue({
      id: "ix-1",
      status: "needs_connection",
      messageId: "msg-1",
      draftVersion: 1,
      staleAt: null,
    });

    const result = await publishL0aView(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      intent: "connect.gmail",
      title: "Connect Gmail",
      status: "needs_connection",
      block: { ...connectBlock, description: "Authorize Gmail again." },
    });

    expect(createInteraction).not.toHaveBeenCalled();
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(result.amended).toBe(true);
    expect(result.interactionId).toBe("ix-1");
    expect(stored.blocks).toEqual([
      expect.objectContaining({
        kind: "app_connect",
        description: "Authorize Gmail again.",
        interactionId: "ix-1",
        cardStatus: "needs_connection",
        status: "pending",
      }),
    ]);
  });

  it("gives two named reconnects two card keys (AC-23)", async () => {
    const { prisma } = fixture();
    createInteraction
      .mockResolvedValueOnce({
        id: "ix-a",
        intent: "connect.gmail.ca_1",
        draftVersion: 1,
        title: "Reconnect Gmail",
        summary: null,
      })
      .mockResolvedValueOnce({
        id: "ix-b",
        intent: "connect.gmail.ca_2",
        draftVersion: 1,
        title: "Reconnect Gmail",
        summary: null,
      });

    const first = await publishL0aView(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      intent: "connect.gmail.ca_1",
      title: "Reconnect Gmail",
      status: "needs_connection",
      block: connectBlock,
    });
    const second = await publishL0aView(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      intent: "connect.gmail.ca_2",
      title: "Reconnect Gmail",
      status: "needs_connection",
      block: connectBlock,
    });

    expect(first.amended).toBe(false);
    expect(second.amended).toBe(false);
    expect(first.interactionId).toBe("ix-a");
    expect(second.interactionId).toBe("ix-b");
    expect(createInteraction).toHaveBeenCalledTimes(2);
  });

  it("settles a terminal L0-A view through the kernel", async () => {
    const { prisma, stored } = fixture();
    stored.blocks = [
      {
        ...connectBlock,
        interactionId: "ix-1",
        cardStatus: "needs_connection",
      },
    ];
    stored.status = "needs_connection";
    findOpenCard.mockResolvedValue({
      id: "ix-1",
      status: "needs_connection",
      messageId: "msg-1",
      draftVersion: 1,
      staleAt: null,
    });
    settleInteraction.mockResolvedValue({ settled: true, previousStatus: "needs_connection" });

    const result = await publishL0aView(prisma as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      intent: "connect.gmail",
      title: "Connect Gmail",
      status: "succeeded",
      block: connectBlock,
    });

    expect(settleInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        interactionId: "ix-1",
        status: "succeeded",
      }),
    );
    expect(createInteraction).not.toHaveBeenCalled();
    expect(result.block).toMatchObject({
      status: "connected",
      cardStatus: "succeeded",
    });
  });
});
