import { AUTO_SETTLEABLE_STATUSES, isConversationalRun } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { restampInteractionSurface, settleInteraction } from "./interaction-kernel-store.js";

const SETTLEABLE = [...AUTO_SETTLEABLE_STATUSES];

/**
 * First stage of a new user message: mark live cards without closing them.
 *
 * Status stays put so a collecting card cannot be confirmed and the unique
 * index still treats this as the one open card. `needs_connection` / `unknown`
 * are not marked (spec E7).
 */
export async function markOpenCardsStale(
  prisma: PrismaClient,
  input: { threadId: string; at: Date },
): Promise<{ marked: string[] }> {
  const rows = await prisma.interaction.findMany({
    where: { threadId: input.threadId, status: { in: SETTLEABLE } },
    select: {
      id: true,
      status: true,
      messageId: true,
      intent: true,
      slots: true,
    },
  });
  const marked: string[] = [];
  for (const row of rows) {
    const written = await prisma.interaction.updateMany({
      where: { id: row.id, status: row.status },
      data: { staleAt: input.at },
    });
    if (written.count !== 1) continue;
    await restampInteractionSurface(prisma, {
      interactionId: row.id,
      messageId: row.messageId,
      intent: row.intent,
      status: row.status,
      slots: (row.slots ?? {}) as Record<string, unknown>,
      stale: true,
    });
    marked.push(row.id);
  }
  return { marked };
}

/**
 * Second stage: close cards that still carry the mark this run observed.
 *
 * A card the person edited, confirmed, or sent in between no longer matches
 * the snapshot (spec E1/E2). A later run's newer mark does not match either
 * (spec E3's cousin, AC-8d).
 */
export async function settleStaleCards(
  prisma: PrismaClient,
  input: { threadId: string; staleAtSnapshot: Date; reason: string },
): Promise<{ settled: string[] }> {
  const rows = await prisma.interaction.findMany({
    where: {
      threadId: input.threadId,
      status: { in: SETTLEABLE },
      staleAt: input.staleAtSnapshot,
    },
    select: { id: true },
  });
  const settled: string[] = [];
  for (const row of rows) {
    const result = await settleInteraction(prisma, {
      interactionId: row.id,
      status: "superseded",
      reason: input.reason,
      staleAtSnapshot: input.staleAtSnapshot,
    });
    if (result.settled) settled.push(row.id);
  }
  return { settled };
}

/**
 * Crash recovery: a mark left behind by a run that never finished is closed
 * the next time this thread starts work (spec E3 / AC-8e).
 */
export async function gcStaleCards(
  prisma: PrismaClient,
  input: { threadId: string; before: Date },
): Promise<{ settled: string[] }> {
  const rows = await prisma.interaction.findMany({
    where: {
      threadId: input.threadId,
      status: { in: SETTLEABLE },
      staleAt: { lt: input.before },
    },
    select: { id: true, staleAt: true },
  });
  const settled: string[] = [];
  for (const row of rows) {
    if (!row.staleAt) continue;
    const result = await settleInteraction(prisma, {
      interactionId: row.id,
      status: "superseded",
      reason: "stale_gc",
      staleAtSnapshot: row.staleAt,
    });
    if (result.settled) settled.push(row.id);
  }
  return { settled };
}

/** Crash leftovers from an earlier turn; this turn's own marks stay (`staleAt === createdAt`). */
export async function gcStaleCardsForRun(
  prisma: PrismaClient,
  run: { threadId: string; createdAt: Date; trigger: string },
): Promise<void> {
  if (!isConversationalRun(run.trigger)) return;
  await gcStaleCards(prisma, { threadId: run.threadId, before: run.createdAt });
}

/** Hard-settle cards still carrying the mark written for this run's user message. */
export async function settleStaleCardsForRun(
  prisma: PrismaClient,
  run: { threadId: string; createdAt: Date; trigger: string },
): Promise<void> {
  if (!isConversationalRun(run.trigger)) return;
  await settleStaleCards(prisma, {
    threadId: run.threadId,
    staleAtSnapshot: run.createdAt,
    reason: "user_message",
  });
}
