import type { InteractionPlan, MessageBlock } from "@matebot/contracts";
import type { InteractionResumePlan, InteractionStatus, L0aBlock } from "@matebot/core";
import {
  expiresAtFor,
  isL0aBlock,
  isTerminalStatus,
  l0aScene,
  planWithResumePlan,
  stampL0aBlock,
} from "@matebot/core";
import type { PrismaClient, RunLease } from "@matebot/db";
import {
  appendEventInTransaction,
  appendInteractionEvent,
  createInteraction,
  createThreadMessageInTransaction,
  withTransactionRetry,
} from "@matebot/db";
import type { OpenCardRow } from "./interaction-kernel-store.js";
import { findOpenCard, settleInteraction } from "./interaction-kernel-store.js";

export type PublishL0aViewInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId?: string;
  lease?: RunLease;
  intent: string;
  title: string;
  status: InteractionStatus;
  block: L0aBlock;
  resumePlan?: InteractionResumePlan;
  expiresAt?: Date | null;
  clientNonce?: string;
  reason?: string;
};

export type PublishL0aViewResult = {
  interactionId: string;
  messageId: string;
  draftVersion: number;
  eventSeq: number;
  amended: boolean;
  block: L0aBlock;
};

function l0aPlanFor(
  intent: string,
  title: string,
  resumePlan: InteractionResumePlan | undefined,
): InteractionPlan {
  const scene = l0aScene(intent);
  const nextStep =
    scene === "connect" ? "request_connection" : scene === "approval" ? "request_approval" : "ask";
  return planWithResumePlan(
    {
      intent,
      title,
      fields: [],
      nextStep,
      riskLevel: "low",
    },
    resumePlan,
  );
}

function replaceL0aBlock(
  blocks: MessageBlock[],
  interactionId: string,
  next: L0aBlock,
): MessageBlock[] {
  const has = blocks.some((entry) => isL0aBlock(entry) && entry.interactionId === interactionId);
  if (has) {
    return blocks.map((entry) =>
      isL0aBlock(entry) && entry.interactionId === interactionId ? next : entry,
    );
  }
  return [...blocks, next];
}

/**
 * Publish an L0-A view as an Interaction row, or rewrite the live card.
 *
 * Does not compile A2UI. Connect / approval / question blocks stay their own
 * kinds; the kernel row is the source of truth and the block carries a derived
 * snapshot.
 */
export async function publishL0aView(
  prisma: PrismaClient,
  input: PublishL0aViewInput,
): Promise<PublishL0aViewResult> {
  const expiresAt = input.expiresAt === undefined ? expiresAtFor(input.status) : input.expiresAt;
  const plan = l0aPlanFor(input.intent, input.title, input.resumePlan);

  if (isTerminalStatus(input.status)) {
    const existing = await findOpenCard(prisma, {
      threadId: input.threadId,
      intent: input.intent,
    });
    if (!existing?.messageId) {
      throw new Error("No open L0-A card to settle");
    }
    await settleInteraction(prisma, {
      interactionId: existing.id,
      status: input.status,
      reason: input.reason ?? "l0a",
    });
    const block = stampL0aBlock(input.block, {
      interactionId: existing.id,
      cardStatus: input.status,
    });
    return {
      interactionId: existing.id,
      messageId: existing.messageId,
      draftVersion: existing.draftVersion,
      eventSeq: 0,
      amended: true,
      block,
    };
  }

  const existing = await findOpenCard(prisma, {
    threadId: input.threadId,
    intent: input.intent,
  });
  if (existing?.messageId) {
    return amendL0aView(prisma, input, existing, plan, expiresAt);
  }
  return createL0aView(prisma, input, plan, expiresAt);
}

async function createL0aView(
  prisma: PrismaClient,
  input: PublishL0aViewInput,
  plan: InteractionPlan,
  expiresAt: Date | null,
): Promise<PublishL0aViewResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
      const interaction = await createInteraction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        runId: input.runId,
        intent: input.intent,
        status: input.status,
        plan,
        title: input.title,
        ...(expiresAt ? { expiresAt } : {}),
      });
      const block = stampL0aBlock(input.block, {
        interactionId: interaction.id,
        cardStatus: input.status,
      });
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks: [block],
        botId: input.botId,
        runId: input.runId,
        lease: input.lease,
        clientNonce: input.clientNonce,
      });
      await tx.interaction.update({
        where: { id: interaction.id },
        data: { messageId: message.id },
      });
      await appendInteractionEvent(tx, {
        interactionId: interaction.id,
        kind: "published",
        toStatus: input.status,
        reason: "present",
        runId: input.runId,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        lease: input.lease,
        payload: { messageId: message.id, role: "bot", blocks: [block] },
      });
      return {
        interactionId: interaction.id,
        messageId: message.id,
        draftVersion: interaction.draftVersion,
        eventSeq: event.seq,
        amended: false,
        block,
      };
    }),
  );
}

async function amendL0aView(
  prisma: PrismaClient,
  input: PublishL0aViewInput,
  existing: OpenCardRow,
  plan: InteractionPlan,
  expiresAt: Date | null,
): Promise<PublishL0aViewResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "interactions" WHERE id = ${existing.id} FOR UPDATE`;
      const locked = await tx.interaction.findUnique({
        where: { id: existing.id },
        select: { status: true, draftVersion: true },
      });
      if (!locked || locked.status !== existing.status) {
        throw new Error("The card changed while it was being amended");
      }
      const nextVersion = locked.draftVersion + 1;
      const message = await tx.message.findUnique({
        where: { id: existing.messageId! },
        select: { blocks: true },
      });
      const previous = Array.isArray(message?.blocks) ? (message.blocks as MessageBlock[]) : [];
      const block = stampL0aBlock(input.block, {
        interactionId: existing.id,
        cardStatus: input.status,
      });
      const written = await tx.interaction.updateMany({
        where: {
          id: existing.id,
          status: existing.status,
          draftVersion: locked.draftVersion,
        },
        data: {
          plan: plan as never,
          title: input.title,
          draftVersion: nextVersion,
          staleAt: null,
          expiresAt,
        },
      });
      if (written.count !== 1) {
        throw new Error("The card changed while it was being amended");
      }
      await appendInteractionEvent(tx, {
        interactionId: existing.id,
        kind: "amended",
        fromStatus: existing.status,
        toStatus: input.status,
        reason: "present",
        runId: input.runId,
      });
      const nextBlocks = replaceL0aBlock(previous, existing.id, block);
      await tx.message.update({
        where: { id: existing.messageId! },
        data: { blocks: nextBlocks as never },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.updated",
        runId: input.runId,
        lease: input.lease,
        payload: { messageId: existing.messageId, role: "bot", blocks: nextBlocks },
      });
      return {
        interactionId: existing.id,
        messageId: existing.messageId!,
        draftVersion: nextVersion,
        eventSeq: event.seq,
        amended: true,
        block,
      };
    }),
  );
}
