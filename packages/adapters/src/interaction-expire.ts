import type { JobPublisher } from "@matebot/adapter-kit";
import { interactionExpireJob } from "@matebot/adapter-kit";
import { OPEN_STATUSES } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { settleInteraction } from "./interaction-kernel-store.js";

const OPEN = [...OPEN_STATUSES];

/**
 * Close one due approval card.
 *
 * `unknown` and `needs_connection` are not in the open set, so a mistaken
 * `expiresAt` on those rows is ignored (spec D2 / E7).
 */
export async function expireInteraction(
  prisma: PrismaClient,
  interactionId: string,
  now: Date = new Date(),
): Promise<{ expired: boolean }> {
  const row = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!row?.expiresAt || row.expiresAt > now) return { expired: false };
  if (!OPEN.includes(row.status as (typeof OPEN)[number])) return { expired: false };
  const result = await settleInteraction(prisma, {
    interactionId: row.id,
    status: "expired",
    reason: "approval window ended",
  });
  return { expired: result.settled };
}

/**
 * Settle every open card whose window has already ended.
 *
 * Used by tests and the isolated live path. Production also enqueues one
 * delayed job per card; this sweep is the same closer those jobs call.
 */
export async function expireDueInteractions(
  prisma: PrismaClient,
  input: { now?: Date; interactionId?: string } = {},
): Promise<{ expired: string[] }> {
  const now = input.now ?? new Date();
  const rows = await prisma.interaction.findMany({
    where: {
      ...(input.interactionId ? { id: input.interactionId } : {}),
      expiresAt: { lt: now },
      status: { in: OPEN },
    },
    select: { id: true },
  });
  const expired: string[] = [];
  for (const row of rows) {
    const result = await expireInteraction(prisma, row.id, now);
    if (result.expired) expired.push(row.id);
  }
  return { expired };
}

export async function scheduleInteractionExpiry(
  jobs: Pick<JobPublisher, "enqueue">,
  interactionId: string,
  expiresAt: Date,
  options: { keepExisting?: boolean } = {},
): Promise<void> {
  await jobs.enqueue({
    ...interactionExpireJob(interactionId, expiresAt),
    ...(options.keepExisting ? { keepExisting: true } : {}),
  });
}

/** Re-queue a delayed job for every due open card whose job was lost. */
export async function reconcileDueInteractionExpiry(
  prisma: PrismaClient,
  jobs: Pick<JobPublisher, "enqueue">,
  options: { now?: Date; take?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const rows = await prisma.interaction.findMany({
    where: { expiresAt: { lt: now }, status: { in: OPEN } },
    select: { id: true, expiresAt: true },
    take: options.take ?? 100,
  });
  for (const row of rows) {
    if (!row.expiresAt) continue;
    await scheduleInteractionExpiry(jobs, row.id, row.expiresAt, { keepExisting: true });
  }
  return rows.length;
}
