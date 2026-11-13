import type { InteractionPlan } from "@matebot/contracts";
import { interactionCardKey } from "@matebot/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCardRow } from "./interaction-kernel-store.js";

const createInteraction = vi.fn();
const upsertInteractionSurface = vi.fn();
const createThreadMessageInTransaction = vi.fn();
const appendEventInTransaction = vi.fn();
vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    // The insert is the observable effect this suite is about, so it is wrapped
    // rather than left to a real client. The rest of the publish path is stubbed
    // for the same reason: these cases assert on which writes happen, not on SQL.
    createInteraction: (...args: unknown[]) => createInteraction(...args),
    upsertInteractionSurface: (...args: unknown[]) => upsertInteractionSurface(...args),
    createThreadMessageInTransaction: (...args: unknown[]) =>
      createThreadMessageInTransaction(...args),
    appendEventInTransaction: (...args: unknown[]) => appendEventInTransaction(...args),
    withTransactionRetry: async (work: () => Promise<unknown>) => work(),
  };
});

const { publishOrAmend } = await import("./interaction-publish.js");

const plan: InteractionPlan = {
  intent: "email.compose",
  title: "产品发布",
  fields: [
    { name: "to", value: "to@example.com", required: true, status: "resolved" },
    { name: "subject", value: "产品发布", required: true, status: "resolved" },
    { name: "body", value: "内容", required: true, status: "resolved" },
  ],
  // "confirm" is not in the plan vocabulary; "ask" is what a fully resolved draft
  // that still needs a person says.
  nextStep: "ask",
  riskLevel: "low",
};

const openCard: OpenCardRow = {
  id: "i1",
  status: "collecting",
  messageId: "m1",
  draftVersion: 1,
  staleAt: null,
};

function amendPrisma(existing: typeof openCard) {
  const updateInteraction = vi.fn().mockResolvedValue({});
  const updateMessage = vi.fn().mockResolvedValue({});
  const tx = {
    interaction: { update: updateInteraction },
    message: {
      findUnique: vi.fn().mockResolvedValue({
        id: "m1",
        blocks: [{ kind: "a2ui_surface", interactionId: "i1", surfaceId: "s1", draftVersion: 1 }],
      }),
      update: updateMessage,
    },
  };
  const prisma = {
    interaction: { findFirst: vi.fn().mockResolvedValue(existing) },
    $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
  };
  return { prisma, updateInteraction, updateMessage };
}

describe("publishOrAmend", () => {
  beforeEach(() => {
    createInteraction.mockReset();
    upsertInteractionSurface.mockReset();
    createThreadMessageInTransaction.mockReset();
    appendEventInTransaction.mockReset();

    upsertInteractionSurface.mockResolvedValue({
      documentRef: "a2ui:interaction:i1:surface:s1",
    });
    createThreadMessageInTransaction.mockResolvedValue({ id: "m-new" });
    appendEventInTransaction.mockResolvedValue({ id: "e1", seq: 3 });
  });

  it("writes the card key so the unique index can do its job", async () => {
    createInteraction.mockResolvedValue({
      id: "i1",
      intent: "email.compose",
      draftVersion: 1,
      title: "产品发布",
      summary: null,
    });
    const tx = {
      interaction: { update: vi.fn().mockResolvedValue({}) },
      message: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      interaction: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
    };

    const result = await publishOrAmend(prisma as never, {
      spaceId: "s1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(result.amended).toBe(false);
    expect(createInteraction).toHaveBeenCalledTimes(1);
    expect(createInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cardKey: interactionCardKey("t1", "email.compose") }),
    );
  });

  it("amends the existing card instead of creating a second one", async () => {
    const { prisma, updateInteraction, updateMessage } = amendPrisma(openCard);

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(result.amended).toBe(true);
    expect(result.interactionId).toBe("i1");
    expect(result.messageId).toBe("m1");
    expect(result.draftVersion).toBe(2);
    // The message is rewritten, never appended: a new row per present is the bug.
    expect(createInteraction).not.toHaveBeenCalled();
    expect(upsertInteractionSurface).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1" } }),
    );
    expect(updateInteraction.mock.calls[0]![0].data).toMatchObject({ draftVersion: 2 });
  });

  it("replaces the card's own block rather than adding a second surface", async () => {
    const { prisma, updateMessage } = amendPrisma(openCard);

    await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    const blocks = updateMessage.mock.calls[0]![0].data.blocks as {
      kind: string;
      interactionId: string;
      draftVersion: number;
    }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "a2ui_surface",
      interactionId: "i1",
      draftVersion: 2,
    });
  });

  it("clears the staleness mark when it rewrites the card", async () => {
    const { prisma, updateInteraction } = amendPrisma({ ...openCard, staleAt: new Date() });

    await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(updateInteraction.mock.calls[0]![0].data).toMatchObject({ staleAt: null });
  });

  it("re-reads and amends when an insert races another run", async () => {
    const { prisma, updateMessage } = amendPrisma(openCard);
    prisma.interaction.findFirst.mockReset();
    prisma.interaction.findFirst.mockResolvedValueOnce(null).mockResolvedValue(openCard);
    createInteraction.mockRejectedValue({ code: "P2002" });

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(result.amended).toBe(true);
    expect(result.interactionId).toBe("i1");
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });
});
