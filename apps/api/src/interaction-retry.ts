import { reviveCard, senderStampFromBlock } from "@matebot/adapters";
import type { A2uiSurfaceBlock, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import type { InteractionStatus } from "@matebot/core";
import { surfaceStampFor } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import {
  appendEventInTransaction,
  getInteraction,
  InteractionNotFoundError,
  withTransactionRetry,
} from "@matebot/db";

export class InteractionRetryRejectedError extends Error {
  readonly code: "not_revivable" | "concurrent";
  constructor(code: "not_revivable" | "concurrent") {
    super(
      code === "concurrent" ? "Interaction was updated elsewhere" : "This card cannot be retried",
    );
    this.name = "InteractionRetryRejectedError";
    this.code = code;
  }
}

function protocolFamilyOf(value: string): "v0_9" | "v1_0" {
  return value === "v1_0" || value === "v0_9" ? value : "v0_9";
}

export async function retryInteractionService(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; botId: string; interactionId: string },
): Promise<{
  interactionId: string;
  surfaceId: string;
  draftVersion: number;
  status: InteractionStatus;
}> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current || current.threadId !== input.threadId || current.spaceId !== input.spaceId) {
    throw new InteractionNotFoundError(input.interactionId);
  }

  const revived = await reviveCard(prisma, { interactionId: input.interactionId });
  if (!revived.revived) {
    if (revived.reason === "not_found") throw new InteractionNotFoundError(input.interactionId);
    throw new InteractionRetryRejectedError(revived.reason);
  }

  const surfaceRow = await prisma.interactionSurface.findFirst({
    where: { interactionId: input.interactionId },
    orderBy: { updatedAt: "desc" },
  });
  if (!surfaceRow) throw new InteractionNotFoundError(input.interactionId);

  const stamps = surfaceStampFor({
    status: revived.status,
    intent: current.intent,
  });
  const protocolFamily = protocolFamilyOf(surfaceRow.protocolFamily);

  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.interactionSurface.update({
        where: { id: surfaceRow.id },
        data: { draftVersion: revived.draftVersion },
      });
      if (!current.messageId) return;
      const message = await tx.message.findUnique({ where: { id: current.messageId } });
      if (!message) return;
      const existing = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
      const sender = senderStampFromBlock(existing, surfaceRow.surfaceId);
      const previous = existing.find(
        (entry): entry is A2uiSurfaceBlock =>
          entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId,
      );
      const block: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: input.interactionId,
        surfaceId: surfaceRow.surfaceId,
        protocolFamily,
        draftVersion: revived.draftVersion,
        intent: current.intent,
        ...(current.title
          ? { title: current.title }
          : previous?.title
            ? { title: previous.title }
            : {}),
        ...(current.summary
          ? { summary: current.summary }
          : previous?.summary
            ? { summary: previous.summary }
            : {}),
        documentRef: a2uiSurfaceDocumentRef({
          interactionId: input.interactionId,
          surfaceId: surfaceRow.surfaceId,
        }),
        ...stamps,
        ...(sender.senderLabel ? { senderLabel: sender.senderLabel } : {}),
        ...(sender.senderAddress ? { senderAddress: sender.senderAddress } : {}),
        ...(previous && "capability" in previous && previous.capability
          ? { capability: previous.capability }
          : {}),
      };
      const blocks = existing.some(
        (entry) => entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId,
      )
        ? existing.map((entry) =>
            entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId
              ? block
              : entry,
          )
        : [...existing, block];
      await tx.message.update({
        where: { id: current.messageId },
        data: { blocks: blocks as never },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.updated",
        runId: current.runId ?? undefined,
        payload: { messageId: current.messageId, role: "bot", blocks },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.surface.updated",
        runId: current.runId ?? undefined,
        payload: {
          interactionId: input.interactionId,
          surfaceId: surfaceRow.surfaceId,
          protocolFamily,
          draftVersion: revived.draftVersion,
          intent: current.intent,
          title: current.title ?? undefined,
          summary: current.summary ?? undefined,
          documentRef: a2uiSurfaceDocumentRef({
            interactionId: input.interactionId,
            surfaceId: surfaceRow.surfaceId,
          }),
          messageId: current.messageId,
        },
      });
    }),
  );

  return {
    interactionId: input.interactionId,
    surfaceId: surfaceRow.surfaceId,
    draftVersion: revived.draftVersion,
    status: revived.status,
  };
}
