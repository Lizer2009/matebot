import { publishOrAmend, settleInteraction } from "@matebot/adapters";
import type { InteractionPlan, MessageBlock } from "@matebot/contracts";
import { surfaceStampFor } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { asSystem } from "@matebot/db";

/**
 * Isolated E2E seed — not the C-batch expiry scanner.
 *
 * Batch B has no worker that stamps `expired` onto the message block.
 * `settleInteraction` only writes `Interaction.status`; a status-only UPDATE
 * would still look like a draft on refresh. This seed is the labeled stand-in:
 * it settles through the production closer, then restamps the same
 * `a2ui_surface` block with `surfaceStampFor` (the same mapping every writer
 * uses). It does not write `staleAt`, scan rows, or schedule expiry.
 */

export type SeededSurface = {
  interactionId: string;
  cardKey: string | null;
  messageId: string | null;
  status: string;
  draftVersion: number;
  surfaceId: string | null;
  block: {
    interactionId: string;
    surfaceId: string;
    status: string | null;
    template: string | null;
    lifecycle: string | null;
    draftVersion: number;
  } | null;
};

function surfaceFrom(blocks: unknown, interactionId: string): MessageBlock | undefined {
  if (!Array.isArray(blocks)) return undefined;
  return blocks.find(
    (entry) =>
      (entry as { kind?: string }).kind === "a2ui_surface" &&
      (entry as { interactionId?: string }).interactionId === interactionId,
  ) as MessageBlock | undefined;
}

function snapshotBlock(block: MessageBlock | undefined): SeededSurface["block"] {
  if (block?.kind !== "a2ui_surface") return null;
  return {
    interactionId: block.interactionId,
    surfaceId: block.surfaceId,
    status: "status" in block && typeof block.status === "string" ? block.status : null,
    template: "template" in block && typeof block.template === "string" ? block.template : null,
    lifecycle: "lifecycle" in block && typeof block.lifecycle === "string" ? block.lifecycle : null,
    draftVersion: block.draftVersion,
  };
}

export async function inspectSeededSurface(
  prisma: PrismaClient,
  interactionId: string,
): Promise<SeededSurface> {
  const system = asSystem(prisma, "isolated e2e surface inspect");
  const row = await system.interaction.findUnique({ where: { id: interactionId } });
  if (!row) throw new Error(`missing interaction ${interactionId}`);
  const surface = await system.interactionSurface.findFirst({
    where: { interactionId },
    orderBy: { updatedAt: "desc" },
  });
  const message = row.messageId
    ? await system.message.findUnique({ where: { id: row.messageId } })
    : null;
  return {
    interactionId: row.id,
    cardKey: row.cardKey,
    messageId: row.messageId,
    status: row.status,
    draftVersion: row.draftVersion,
    surfaceId: surface?.surfaceId ?? null,
    block: snapshotBlock(surfaceFrom(message?.blocks, interactionId)),
  };
}

/** Isolated live fixture: rewrite through `publishOrAmend`, never a raw status UPDATE. */
export async function amendLiveCardForE2e(
  prisma: PrismaClient,
  input: {
    interactionId: string;
    status: "ready_for_review" | "awaiting_approval";
    expiresAt?: Date | null;
  },
): Promise<void> {
  const system = asSystem(prisma, "isolated e2e amend live card");
  const row = await system.interaction.findUnique({ where: { id: input.interactionId } });
  if (!row) throw new Error(`missing interaction ${input.interactionId}`);
  const thread = await system.thread.findUnique({
    where: { id: row.threadId },
    select: { botId: true },
  });
  if (!thread?.botId) throw new Error(`interaction ${input.interactionId} thread has no bot`);
  await publishOrAmend(system, {
    spaceId: row.spaceId,
    threadId: row.threadId,
    botId: thread.botId,
    plan: row.plan as InteractionPlan,
    status: input.status,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });
}

export async function seedExpiredSurface(
  prisma: PrismaClient,
  interactionId: string,
): Promise<SeededSurface> {
  const system = asSystem(prisma, "isolated e2e expired-surface seed");
  const row = await system.interaction.findUnique({ where: { id: interactionId } });
  if (!row) throw new Error(`missing interaction ${interactionId}`);
  const settled = await settleInteraction(system, {
    interactionId,
    status: "expired",
    reason: "isolated e2e seed; not expiry scan",
  });
  if (!settled.settled && settled.reason === "exempt_from_settlement") {
    // Live e2e has no mailbox or calendar provider (external writes stay
    // paused), so present_interaction lands on needs_connection. The kernel
    // will not expire that status — that is not a hole in this seed. Amend
    // through the production publisher onto an open status, then settle.
    // Not the C-batch scanner and does not write staleAt.
    await amendLiveCardForE2e(prisma, { interactionId, status: "ready_for_review" });
    const after = await settleInteraction(system, {
      interactionId,
      status: "expired",
      reason: "isolated e2e seed after labeled open-status fixture; not expiry scan",
    });
    if (!after.settled) {
      throw new Error(`settle refused: ${"reason" in after ? after.reason : "unknown"}`);
    }
  } else if (!settled.settled) {
    throw new Error(`settle refused: ${"reason" in settled ? settled.reason : "unknown"}`);
  }
  if (!row.messageId) throw new Error(`interaction ${interactionId} has no message`);
  const message = await system.message.findUnique({ where: { id: row.messageId } });
  if (!message) throw new Error(`missing message ${row.messageId}`);
  const existing = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
  const stamps = surfaceStampFor({ status: "expired", intent: row.intent });
  const blocks = existing.map((entry) =>
    entry.kind === "a2ui_surface" && entry.interactionId === interactionId
      ? { ...entry, ...stamps }
      : entry,
  );
  if (!surfaceFrom(blocks, interactionId)) {
    throw new Error(`interaction ${interactionId} has no surface block to stamp`);
  }
  await system.message.update({
    where: { id: message.id },
    data: { blocks: blocks as never },
  });
  return inspectSeededSurface(prisma, interactionId);
}
