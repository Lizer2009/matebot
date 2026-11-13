import type { InteractionPlan } from "@matebot/contracts";
import { interactionCardKey } from "@matebot/core/node/interaction-card-key";
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
    appendInteractionEvent: vi.fn(async () => undefined),
    withTransactionRetry: async (work: () => Promise<unknown>) => work(),
  };
});

const { InteractionCardOccupiedError, publishOrAmend } = await import("./interaction-publish.js");

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

const APPROVAL_TTL_MS = 30 * 60 * 1000;

const callInput = (index = 0) => {
  const args = createInteraction.mock.calls[index]![1] as Record<string, unknown>;
  return args;
};

function amendPrisma(existing: OpenCardRow, surfaceId = "s1", amendsInteractionId?: string) {
  const updateInteraction = vi.fn().mockResolvedValue({ count: 1 });
  const updateMessage = vi.fn().mockResolvedValue({});
  // The row as it is once the amend holds its lock. Mutable, so a case can make
  // the locked row disagree with the lookup that found the card.
  const txFindUnique = vi.fn(async () => ({
    status: existing.status,
    draftVersion: existing.draftVersion,
  }));
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    interaction: {
      updateMany: updateInteraction,
      update: vi.fn().mockResolvedValue({}),
      findUnique: txFindUnique,
    },
    message: {
      findUnique: vi.fn().mockResolvedValue({
        id: "m1",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "i1",
            surfaceId,
            draftVersion: 1,
            ...(amendsInteractionId ? { amendsInteractionId } : {}),
          },
        ],
      }),
      update: updateMessage,
    },
  };
  const prisma = {
    interaction: {
      findFirst: vi.fn(async ({ where }: { where: { status?: { in?: string[] } } }) =>
        where.status?.in?.includes(existing.status) ? existing : null,
      ),
    },
    interactionSurface: { findFirst: vi.fn().mockResolvedValue({ surfaceId }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
  };
  return { prisma, updateInteraction, updateMessage, txFindUnique };
}

function publishPrisma() {
  const tx = {
    interaction: { update: vi.fn().mockResolvedValue({}) },
    message: { update: vi.fn().mockResolvedValue({}) },
  };
  return {
    interaction: { findFirst: vi.fn().mockResolvedValue(null) },
    interactionSurface: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
  };
}

describe("publishOrAmend", () => {
  beforeEach(() => {
    createInteraction.mockReset();
    upsertInteractionSurface.mockReset();
    createThreadMessageInTransaction.mockReset();
    appendEventInTransaction.mockReset();

    createInteraction.mockResolvedValue({
      id: "i1",
      intent: "email.compose",
      draftVersion: 1,
      title: "产品发布",
      summary: null,
    });
    upsertInteractionSurface.mockResolvedValue({
      documentRef: "a2ui:interaction:i1:surface:s1",
    });
    createThreadMessageInTransaction.mockResolvedValue({ id: "m-new" });
    appendEventInTransaction.mockResolvedValue({ id: "e1", seq: 3 });
  });

  it("does not create an open draft when skipDraft is set", async () => {
    const prisma = publishPrisma();
    const result = await publishOrAmend(prisma as never, {
      spaceId: "s1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
      skipDraft: true,
    });
    expect(result).toEqual({ skipped: true, reason: "drafts_disabled" });
    expect(createInteraction).not.toHaveBeenCalled();
  });

  it("writes the card key so the unique index can do its job", async () => {
    const prisma = publishPrisma();

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
      expect.objectContaining({
        // The write is a compare-and-set: the row must still carry the revision
        // and status the amend was built from.
        where: { id: "i1", status: "collecting", draftVersion: 1 },
      }),
    );
    expect(updateInteraction.mock.calls[0]![0].data).toMatchObject({ draftVersion: 2 });
  });

  it("rewrites the surface the card already uses instead of inserting a new one", async () => {
    const { prisma, updateMessage } = amendPrisma(openCard);
    const surfaceFindFirst = vi.mocked(prisma.interactionSurface.findFirst);

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(surfaceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { interactionId: "i1" }, orderBy: { updatedAt: "desc" } }),
    );
    // One surface row per card: the client keys blocks by interactionId:surfaceId,
    // so a fresh id here would render the old card and the new one side by side.
    expect(result.surfaceId).toBe("s1");
    expect(upsertInteractionSurface).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ interactionId: "i1", surfaceId: "s1" }),
    );

    const blocks = updateMessage.mock.calls[0]![0].data.blocks as {
      kind: string;
      interactionId: string;
      surfaceId: string;
      draftVersion: number;
    }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "a2ui_surface",
      interactionId: "i1",
      surfaceId: "s1",
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

  it("derives an approval expiry and leaves other statuses without one", async () => {
    const prisma = publishPrisma();

    await publishOrAmend(prisma as never, {
      spaceId: "s1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
      status: "awaiting_approval",
    });
    const expiresAt = callInput().expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(APPROVAL_TTL_MS - 5_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(APPROVAL_TTL_MS);

    createInteraction.mockClear();
    const collecting = publishPrisma();
    await publishOrAmend(collecting as never, {
      spaceId: "s1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    // No expiry is written for a card the user is still editing, so the row keeps its null.
    expect(callInput().expiresAt).toBeUndefined();
  });

  it("writes the reused expiry when it amends", async () => {
    const { prisma, updateInteraction } = amendPrisma(openCard);
    const expiresAt = new Date("2026-11-13T12:00:00.000Z");

    await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
      status: "awaiting_approval",
      expiresAt,
    });

    expect(updateInteraction.mock.calls[0]![0].data).toMatchObject({ expiresAt });
  });

  it("keeps an explicit null expiry instead of deriving one", async () => {
    const { prisma, updateInteraction } = amendPrisma(openCard);

    await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
      status: "awaiting_approval",
      expiresAt: null,
    });

    expect(updateInteraction.mock.calls[0]![0].data).toMatchObject({ expiresAt: null });
  });

  it("closes a live card with no message before publishing a new one", async () => {
    const messageLess: OpenCardRow = { ...openCard, messageId: null };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      interaction: { update: vi.fn().mockResolvedValue({}) },
      message: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      interaction: {
        findFirst: vi.fn().mockResolvedValue(messageLess),
        findUnique: vi.fn().mockResolvedValue({ id: "i1", status: "collecting", staleAt: null }),
        updateMany,
      },
      interactionSurface: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
    };

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    // A row that shows nothing must not hold the card key forever.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "i1", status: "collecting" },
        data: expect.objectContaining({ status: "superseded" }),
      }),
    );
    expect(createInteraction).toHaveBeenCalledTimes(1);
    expect(result.amended).toBe(false);
  });

  // A waiting connection card is looked up (so a repeat present amends it) but
  // is not in the partial index: different intents may each be waiting.
  it("amends a waiting connection card instead of stacking a second one", async () => {
    const { prisma } = amendPrisma({ ...openCard, status: "needs_connection" });

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(result.amended).toBe(true);
    expect(result.interactionId).toBe("i1");
    expect(result.draftVersion).toBe(2);
    expect(createInteraction).not.toHaveBeenCalled();
  });

  // Amending a card mid-send is unsafe, so the lookup must not see it.
  it("does not amend a card that is already executing", async () => {
    const { prisma } = amendPrisma({ ...openCard, status: "executing" });

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(prisma.interaction.findFirst.mock.calls[0]![0].where.status?.in ?? []).not.toContain(
      "executing",
    );
    expect(result.amended).toBe(false);
    expect(createInteraction).toHaveBeenCalledTimes(1);
  });

  it("turns a second present for one intent into one card with one block", async () => {
    // The card the first present created names the record it amends; the second
    // present of the same correction is what must amend it rather than stack.
    const { prisma, updateMessage } = amendPrisma(openCard, "s1", "executed-1");
    // First present finds nothing and creates; the second finds that card.
    prisma.interaction.findFirst.mockResolvedValueOnce(null);

    const first = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
      amendsInteractionId: "executed-1",
    });
    const second = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
      amendsInteractionId: "executed-1",
    });

    expect(first.amended).toBe(false);
    expect(second.amended).toBe(true);
    expect(second.interactionId).toBe(first.interactionId);
    expect(second.draftVersion).toBe(first.draftVersion + 1);
    // One row created, one timeline message rewritten: no second card.
    expect(createInteraction).toHaveBeenCalledTimes(1);
    expect(createThreadMessageInTransaction).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const blocks = updateMessage.mock.calls[0]![0].data.blocks as unknown[];
    expect(blocks).toHaveLength(1);
  });

  it("keeps the amendment link when the caller does not restate it", async () => {
    const { prisma, updateMessage } = amendPrisma(openCard, "s1", "executed-1");

    await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    const blocks = updateMessage.mock.calls[0]![0].data.blocks as Array<{
      amendsInteractionId?: string;
    }>;
    expect(blocks[0]?.amendsInteractionId).toBe("executed-1");
  });

  it("amends a correction of the same record", async () => {
    const { prisma, updateMessage } = amendPrisma(openCard, "s1", "executed-1");

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
      amendsInteractionId: "executed-1",
    });

    expect(result.amended).toBe(true);
    const blocks = updateMessage.mock.calls[0]![0].data.blocks as Array<{
      amendsInteractionId?: string;
    }>;
    expect(blocks[0]?.amendsInteractionId).toBe("executed-1");
  });

  // The slot is one card per intent, so it may also be someone else's draft. A
  // correction is about one named record; taking that slot would discard what the
  // person typed there and still report the card as a new correction.
  it("refuses the slot held by an unrelated draft", async () => {
    const { prisma, updateInteraction, updateMessage } = amendPrisma(openCard);

    await expect(
      publishOrAmend(prisma as never, {
        spaceId: "sp1",
        threadId: "t1",
        botId: "b1",
        runId: "r1",
        plan,
        amendsInteractionId: "executed-1",
      }),
    ).rejects.toBeInstanceOf(InteractionCardOccupiedError);

    expect(updateInteraction).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
    expect(upsertInteractionSurface).not.toHaveBeenCalled();
  });

  // The lock is what keeps two presents of one intent from losing a revision:
  // the card is rewritten one at a time, each from the revision the previous
  // write left behind, instead of both writing the same next version.
  it("takes the next revision from the row as it is under the lock", async () => {
    const { prisma, updateInteraction, updateMessage, txFindUnique } = amendPrisma(openCard);
    // A sibling present landed first, so the row is already at revision 2.
    txFindUnique.mockResolvedValue({ status: "collecting", draftVersion: 2 });

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(result.amended).toBe(true);
    expect(result.draftVersion).toBe(3);
    // The write is keyed on the revision read under the lock, not the stale lookup.
    expect(updateInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ draftVersion: 2 }) }),
    );
    expect(updateInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ draftVersion: 3 }) }),
    );
    // Still one card and one message: the second present rewrote the first.
    expect(createInteraction).not.toHaveBeenCalled();
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  // A card that left the draft state while the amend was being built must not be
  // pulled back into it. The retry re-reads, and finds a state it may not amend.
  it("will not reopen a card that was settled meanwhile", async () => {
    const { prisma, updateInteraction, txFindUnique } = amendPrisma(openCard);
    txFindUnique.mockResolvedValue({ status: "sent", draftVersion: 1 });
    prisma.interaction.findFirst.mockResolvedValueOnce(openCard).mockResolvedValue(null);
    createInteraction.mockRejectedValue({ code: "P2002" });

    await expect(
      publishOrAmend(prisma as never, {
        spaceId: "sp1",
        threadId: "t1",
        botId: "b1",
        runId: "r1",
        plan,
      }),
    ).rejects.toBeTruthy();
    // Nothing was written to the card that already left the draft state.
    expect(updateInteraction).not.toHaveBeenCalled();
  });
});
