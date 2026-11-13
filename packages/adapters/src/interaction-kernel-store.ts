import type { InteractionPlan } from "@matebot/contracts";
import type { InteractionStatus, SettleRefusal } from "@matebot/core";
import {
  canRetryStatus,
  decideSettle,
  deriveCollectingStatus,
  historySlotsFromValues,
  OPEN_STATUSES,
  surfaceStampFor,
} from "@matebot/core";
import type { Prisma, PrismaClient } from "@matebot/db";
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
    select: {
      id: true,
      status: true,
      staleAt: true,
      messageId: true,
      intent: true,
      slots: true,
    },
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
    data: { status: decision.status, staleAt: null },
  });
  if (written.count === 0) return { settled: false, reason: "concurrent" };

  await restampInteractionSurface(prisma, {
    interactionId: current.id,
    messageId: current.messageId,
    intent: current.intent,
    status: decision.status,
    slots: (current.slots ?? {}) as Record<string, unknown>,
  });

  getLogger().info("interaction.settled", {
    "interaction.id": input.interactionId,
    "interaction.from": current.status,
    "interaction.to": decision.status,
    "interaction.reason": input.reason,
  });
  return { settled: true, previousStatus: current.status };
}

/**
 * Copy the kernel status onto the timeline block the hosts actually read.
 *
 * Closing the row without this leaves a draft-looking card (B's labeled seed
 * had to do this by hand). `stale` is a freshness flag, not a status: omit it
 * on a settled card, set it while an open card is marked.
 */
export async function restampInteractionSurface(
  prisma: PrismaClient,
  input: {
    interactionId: string;
    messageId: string | null;
    intent: string;
    status: string;
    slots?: Record<string, unknown>;
    stale?: boolean;
  },
): Promise<void> {
  if (!input.messageId) return;
  const message = await prisma.message.findUnique({
    where: { id: input.messageId },
    select: { blocks: true },
  });
  if (!message || !Array.isArray(message.blocks)) return;
  const stamp = surfaceStampFor({ status: input.status, intent: input.intent });
  const historySlots = historySlotsFromValues(input.intent, input.slots ?? {});
  const nextBlocks = message.blocks.map((entry) => {
    const block = entry as { kind?: string; interactionId?: string };
    if (block.kind !== "a2ui_surface" || block.interactionId !== input.interactionId) {
      return entry;
    }
    const next = { ...(entry as Record<string, unknown>), ...stamp };
    delete next.stale;
    if (input.stale) next.stale = true;
    if (historySlots) next.historySlots = historySlots;
    return next;
  });
  await prisma.message.update({
    where: { id: input.messageId },
    data: { blocks: nextBlocks as Prisma.InputJsonValue },
  });
}

export type ReviveResult =
  | { revived: true; status: "collecting" | "ready_for_review"; draftVersion: number }
  | { revived: false; reason: "not_found" | "not_revivable" | "concurrent" };

/**
 * Put a card back in the person's hands.
 *
 * `decideSettle` refuses every terminal→open move on purpose: a settled card must not come back
 * to life behind the user's back. A retry is the one case where coming back is the *requested*
 * outcome, so this is its own path with its own whitelist rather than an exception inside the
 * settle rule. `superseded` is out because another card already carries its content,
 * `cancelled` because the person ended it, and `unknown` because the send may already be out.
 */
export async function reviveCard(
  prisma: PrismaClient,
  input: { interactionId: string },
): Promise<ReviveResult> {
  const current = await prisma.interaction.findUnique({
    where: { id: input.interactionId },
    select: { id: true, status: true, draftVersion: true, plan: true, slots: true },
  });
  if (!current) return { revived: false, reason: "not_found" };
  if (!canRetryStatus(current.status)) return { revived: false, reason: "not_revivable" };

  const slots = (current.slots ?? {}) as Record<string, unknown>;
  const derived = deriveCollectingStatus(current.plan as InteractionPlan, slots, "collecting");
  const status = derived === "ready_for_review" ? "ready_for_review" : "collecting";
  const draftVersion = current.draftVersion + 1;
  const written = await prisma.interaction.updateMany({
    where: { id: current.id, status: current.status, draftVersion: current.draftVersion },
    data: { status, draftVersion, confirmedVersion: null, expiresAt: null, staleAt: null },
  });
  if (written.count !== 1) return { revived: false, reason: "concurrent" };
  getLogger().info("interaction.revived", {
    "interaction.id": current.id,
    "interaction.from": current.status,
    "interaction.to": status,
  });
  return { revived: true, status, draftVersion };
}
