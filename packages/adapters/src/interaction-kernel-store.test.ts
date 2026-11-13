import type { PrismaClient } from "@matebot/db";
import { describe, expect, it, vi } from "vitest";
import { findOpenCard, settleInteraction } from "./interaction-kernel-store.js";

function fakePrisma(
  row: {
    id: string;
    status: string;
    messageId?: string | null;
    draftVersion?: number;
    staleAt?: Date | null;
  } | null,
) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findFirst = vi.fn().mockResolvedValue(
    row
      ? {
          id: row.id,
          status: row.status,
          messageId: row.messageId ?? null,
          draftVersion: row.draftVersion ?? 1,
          staleAt: row.staleAt ?? null,
        }
      : null,
  );
  const findUnique = vi.fn().mockResolvedValue(
    row
      ? {
          id: row.id,
          status: row.status,
          messageId: row.messageId ?? null,
          draftVersion: row.draftVersion ?? 1,
          staleAt: row.staleAt ?? null,
        }
      : null,
  );
  return {
    prisma: { interaction: { findFirst, findUnique, updateMany } } as unknown as PrismaClient,
    updateMany,
    findFirst,
  };
}

describe("findOpenCard", () => {
  it("looks a card up by thread and intent among the open statuses", async () => {
    const { prisma, findFirst } = fakePrisma({ id: "i1", status: "collecting" });
    const row = await findOpenCard(prisma, { threadId: "t1", intent: "email.compose" });
    expect(row).toEqual({
      id: "i1",
      status: "collecting",
      messageId: null,
      draftVersion: 1,
      staleAt: null,
    });
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      threadId: "t1",
      intent: "email.compose",
      status: { in: ["collecting", "ready_for_review", "awaiting_approval"] },
    });
  });

  it("returns undefined when the thread has no open card for the intent", async () => {
    const { prisma } = fakePrisma(null);
    expect(await findOpenCard(prisma, { threadId: "t1", intent: "email.compose" })).toBeUndefined();
  });
});

describe("settleInteraction", () => {
  it("settles an open card", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "ready_for_review" });
    await expect(
      settleInteraction(prisma, {
        interactionId: "i1",
        status: "superseded",
        reason: "new message",
      }),
    ).resolves.toEqual({ settled: true, previousStatus: "ready_for_review" });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]![0].where).toEqual({ id: "i1", status: "ready_for_review" });
  });

  // The guard that keeps a card the user just sent from being relabelled.
  it("matches on the status it read, so a concurrent send wins", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "ready_for_review" });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      settleInteraction(prisma, { interactionId: "i1", status: "superseded", reason: "sweep" }),
    ).resolves.toEqual({ settled: false, reason: "concurrent" });
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      id: "i1",
      status: "ready_for_review",
    });
  });

  it("only settles a row that still carries the staleness mark it read", async () => {
    const mark = new Date("2026-11-13T00:00:00.000Z");
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "collecting", staleAt: mark });
    await settleInteraction(prisma, {
      interactionId: "i1",
      status: "superseded",
      reason: "sweep",
      staleAtSnapshot: mark,
    });
    expect(updateMany.mock.calls[0]![0].where).toMatchObject({ staleAt: mark });
  });

  // An omitted snapshot must leave the filter alone, not filter on `undefined`.
  it("does not filter on staleness when no snapshot was read", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "collecting" });
    await settleInteraction(prisma, {
      interactionId: "i1",
      status: "superseded",
      reason: "sweep",
    });
    expect("staleAt" in updateMany.mock.calls[0]![0].where).toBe(false);
  });

  it("reports not_found for an id that vanished", async () => {
    const { prisma, updateMany } = fakePrisma(null);
    await expect(
      settleInteraction(prisma, { interactionId: "gone", status: "superseded", reason: "sweep" }),
    ).resolves.toEqual({ settled: false, reason: "not_found" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses an exempt card without writing", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "needs_connection" });
    await expect(
      settleInteraction(prisma, { interactionId: "i1", status: "superseded", reason: "sweep" }),
    ).resolves.toEqual({ settled: false, reason: "exempt_from_settlement" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a non-terminal target without writing", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "collecting" });
    await expect(
      settleInteraction(prisma, {
        interactionId: "i1",
        status: "ready_for_review",
        reason: "sweep",
      }),
    ).resolves.toEqual({ settled: false, reason: "not_terminal_target" });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
