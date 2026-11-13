import type { InteractionStatus, SettleRefusal } from "@matebot/core";
import { decideSettle, OPEN_STATUSES } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { getLogger } from "@matebot/logging";

export type OpenCardRow = {
  id: string;
  status: string;
  messageId: string | null;
  draftVersion: number;
  staleAt: Date | null;
};

export type SettleInput = {
  interactionId: string;
  status: InteractionStatus;
  /** Goes to the log, never to the user. Why the card closed is not user copy. */
  reason: string;
  /**
   * When set, the update only applies if the row still carries this mark. The
   * two-stage sweep reads the mark with the card and settles on it, so a card the
   * user touched in between is left alone (spec E1/E2).
   */
  staleAtSnapshot?: Date | null;
};

export type SettleResult =
  | { settled: true; previousStatus: string }
  | { settled: false; reason: SettleRefusal | "not_found" | "concurrent" };

/**
 * Statuses whose live card a new present should amend.
 *
 * `needs_connection` is looked up but deliberately absent from the partial
 * unique index: a mail connection card and a calendar connection card must be
 * able to coexist for different intents, while the same intent re-presented
 * must still amend in place rather than stack a second connection card. The
 * index cannot express that per-intent exception, so the lookup carries it.
 * `executing` is excluded on purpose: amending a card mid-send is unsafe.
 */
const OPEN_LOOKUP_STATUSES = [...OPEN_STATUSES, "needs_connection"] as const;

/**
 * The live card for one intent in one thread, as the partial unique index
 * guarantees there is at most one.
 */
export async function findOpenCard(
  prisma: PrismaClient,
  input: { threadId: string; intent: string },
): Promise<OpenCardRow | undefined> {
  const row = await prisma.interaction.findFirst({
    where: {
      threadId: input.threadId,
      intent: input.intent,
      status: { in: [...OPEN_LOOKUP_STATUSES] },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, messageId: true, draftVersion: true, staleAt: true },
  });
  return row ?? undefined;
}

/**
 * The only path that closes a card.
 *
 * Reads the row, asks the kernel whether the move is allowed, then writes with
 * the status it read in the `WHERE` clause. A card the user confirmed in between
 * therefore fails to match and reports `concurrent` instead of being relabelled
 * as superseded.
 */
export async function settleInteraction(
  prisma: PrismaClient,
  input: SettleInput,
): Promise<SettleResult> {
  const current = await prisma.interaction.findUnique({
    where: { id: input.interactionId },
    select: { id: true, status: true, staleAt: true },
  });
  if (!current) return { settled: false, reason: "not_found" };

  const decision = decideSettle({ current: current.status, next: input.status });
  if (!decision.ok) return { settled: false, reason: decision.reason };

  const written = await prisma.interaction.updateMany({
    where: {
      id: input.interactionId,
      status: current.status,
      ...(input.staleAtSnapshot !== undefined ? { staleAt: input.staleAtSnapshot } : {}),
    },
    data: { status: decision.status },
  });
  if (written.count === 0) return { settled: false, reason: "concurrent" };

  getLogger().info("interaction.settled", {
    "interaction.id": input.interactionId,
    "interaction.from": current.status,
    "interaction.to": decision.status,
    "interaction.reason": input.reason,
  });
  return { settled: true, previousStatus: current.status };
}
