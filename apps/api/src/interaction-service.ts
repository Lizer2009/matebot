import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import {
  applyInteractionFieldChange,
  confirmInteractionDraftState,
  interactionSlotsFromPlan,
  type InteractionLifecycleStatus,
} from "@matebot/core";
import type { Prisma, PrismaClient } from "@matebot/db";
import {
  appendEventInTransaction,
  createInteraction,
  createThreadMessageInTransaction,
  getInteraction,
  InteractionNotFoundError,
  InteractionVersionConflictError,
  upsertInteractionSurface,
  withTransactionRetry,
} from "@matebot/db";

async function compilePlanSurface(input: {
  plan: InteractionPlan;
  surfaceId: string;
  protocolFamily?: A2uiProtocolFamily;
}): Promise<{ protocolFamily: A2uiProtocolFamily; messages: unknown[] }> {
  const { compileInteractionPlan } = await import("@matebot/a2ui-adapter");
  const compiled = await compileInteractionPlan({
    plan: input.plan,
    surfaceId: input.surfaceId,
    protocolFamily: input.protocolFamily ?? "v0_9",
  });
  if (!compiled.ok) {
    throw new Error(compiled.error);
  }
  return { protocolFamily: compiled.protocolFamily, messages: compiled.messages };
}

export type PublishInteractionSurfaceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId?: string;
  plan: InteractionPlan;
  surfaceId?: string;
  protocolFamily?: A2uiProtocolFamily;
};

/** Create Interaction + Surface, post a2ui_surface MessageBlock, emit ProductEvents. */
export async function publishInteractionSurface(
  prisma: PrismaClient,
  input: PublishInteractionSurfaceInput,
): Promise<{
  interactionId: string;
  surfaceId: string;
  messageId: string;
  documentRef: string;
  draftVersion: number;
}> {
  const surfaceId = input.surfaceId?.trim() || `surface-${crypto.randomUUID()}`;
  const compiled = await compilePlanSurface({
    plan: input.plan,
    surfaceId,
    protocolFamily: input.protocolFamily,
  });
  const slots = interactionSlotsFromPlan(input.plan);

  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const interaction = await createInteraction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        runId: input.runId,
        intent: input.plan.intent,
        status: "collecting",
        plan: input.plan,
        slots,
        title: input.plan.title,
        summary: input.plan.summary,
      });
      const { documentRef } = await upsertInteractionSurface(tx, {
        interactionId: interaction.id,
        surfaceId,
        protocolFamily: compiled.protocolFamily,
        document: compiled.messages,
        draftVersion: interaction.draftVersion,
      });
      const block: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: interaction.id,
        surfaceId,
        protocolFamily: compiled.protocolFamily,
        draftVersion: interaction.draftVersion,
        title: input.plan.title,
        summary: input.plan.summary,
        documentRef,
      };
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks: [block],
        botId: input.botId,
        runId: input.runId,
      });
      await tx.interaction.update({
        where: { id: interaction.id },
        data: { messageId: message.id },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, role: "bot", blocks: [block] },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.interaction.created",
        runId: input.runId,
        payload: {
          interactionId: interaction.id,
          intent: interaction.intent,
          draftVersion: interaction.draftVersion,
          title: interaction.title,
          summary: interaction.summary,
          messageId: message.id,
        },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.surface.created",
        runId: input.runId,
        payload: {
          interactionId: interaction.id,
          surfaceId,
          protocolFamily: compiled.protocolFamily,
          draftVersion: interaction.draftVersion,
          title: input.plan.title,
          summary: input.plan.summary,
          documentRef,
          messageId: message.id,
        },
      });
      return {
        interactionId: interaction.id,
        surfaceId,
        messageId: message.id,
        documentRef,
        draftVersion: interaction.draftVersion,
      };
    }),
  );
}

export type UpdateInteractionFieldServiceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  interactionId: string;
  expectedDraftVersion: number;
  name: string;
  value: unknown;
};

export async function updateInteractionFieldService(
  prisma: PrismaClient,
  input: UpdateInteractionFieldServiceInput,
): Promise<{ draftVersion: number }> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current || current.threadId !== input.threadId) {
    throw new InteractionNotFoundError(input.interactionId);
  }

  const plan = current.plan as InteractionPlan;
  const slots =
    current.slots && typeof current.slots === "object" && !Array.isArray(current.slots)
      ? (current.slots as Record<string, unknown>)
      : {};
  const changed = applyInteractionFieldChange(
    {
      status: current.status as InteractionLifecycleStatus,
      draftVersion: current.draftVersion,
      confirmedVersion: current.confirmedVersion,
      plan,
      slots,
    },
    {
      expectedDraftVersion: input.expectedDraftVersion,
      name: input.name,
      value: input.value,
    },
  );
  if (!changed.ok) {
    if (changed.error === "version_conflict") {
      throw new InteractionVersionConflictError(
        input.interactionId,
        input.expectedDraftVersion,
        current.draftVersion,
      );
    }
    throw new Error(changed.message);
  }

  const surfaceRow = await prisma.interactionSurface.findFirst({
    where: { interactionId: input.interactionId },
    orderBy: { updatedAt: "desc" },
  });
  if (!surfaceRow) throw new Error("Interaction has no surface");

  const compiled = await compilePlanSurface({
    plan: changed.plan,
    surfaceId: surfaceRow.surfaceId,
    protocolFamily:
      surfaceRow.protocolFamily === "v1_0" || surfaceRow.protocolFamily === "v0_9"
        ? surfaceRow.protocolFamily
        : "v0_9",
  });

  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.interaction.updateMany({
        where: {
          id: input.interactionId,
          draftVersion: input.expectedDraftVersion,
        },
        data: {
          slots: changed.slots as Prisma.InputJsonValue,
          plan: changed.plan as Prisma.InputJsonValue,
          draftVersion: changed.draftVersion,
          confirmedVersion: null,
          status: changed.status,
          title: changed.plan.title,
          summary: changed.plan.summary,
        },
      });
      if (updated.count !== 1) {
        throw new InteractionVersionConflictError(
          input.interactionId,
          input.expectedDraftVersion,
          current.draftVersion,
        );
      }
      const { documentRef } = await upsertInteractionSurface(tx, {
        interactionId: input.interactionId,
        surfaceId: surfaceRow.surfaceId,
        protocolFamily: compiled.protocolFamily,
        document: compiled.messages,
        draftVersion: changed.draftVersion,
      });
      const block: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: input.interactionId,
        surfaceId: surfaceRow.surfaceId,
        protocolFamily: compiled.protocolFamily,
        draftVersion: changed.draftVersion,
        title: changed.plan.title,
        summary: changed.plan.summary,
        documentRef,
      };
      if (current.messageId) {
        const message = await tx.message.findUnique({ where: { id: current.messageId } });
        if (message) {
          const existing = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
          const blocks = existing.map((entry) =>
            entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId
              ? block
              : entry,
          );
          const has = blocks.some(
            (entry) => entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId,
          );
          const nextBlocks = has ? blocks : [...blocks, block];
          await tx.message.update({
            where: { id: current.messageId },
            data: { blocks: nextBlocks as Prisma.InputJsonValue },
          });
          await appendEventInTransaction(tx, {
            spaceId: input.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            type: "thread.message.updated",
            runId: current.runId ?? undefined,
            payload: { messageId: current.messageId, role: "bot", blocks: nextBlocks },
          });
        }
      }
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.interaction.field_changed",
        runId: current.runId ?? undefined,
        payload: {
          interactionId: input.interactionId,
          draftVersion: changed.draftVersion,
          fieldName: input.name,
          messageId: current.messageId ?? undefined,
        },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.interaction.updated",
        runId: current.runId ?? undefined,
        payload: {
          interactionId: input.interactionId,
          draftVersion: changed.draftVersion,
          confirmedVersion: undefined,
          title: changed.plan.title,
          summary: changed.plan.summary,
          messageId: current.messageId ?? undefined,
        },
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
          protocolFamily: compiled.protocolFamily,
          draftVersion: changed.draftVersion,
          title: changed.plan.title,
          summary: changed.plan.summary,
          documentRef: a2uiSurfaceDocumentRef({
            interactionId: input.interactionId,
            surfaceId: surfaceRow.surfaceId,
          }),
          messageId: current.messageId ?? undefined,
        },
      });
    }),
  );

  return { draftVersion: changed.draftVersion };
}

export type ConfirmInteractionServiceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  interactionId: string;
  draftVersion: number;
  approvalEffectId?: string;
};

export async function confirmInteractionService(
  prisma: PrismaClient,
  input: ConfirmInteractionServiceInput,
): Promise<{ confirmedVersion: number }> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current || current.threadId !== input.threadId) {
    throw new InteractionNotFoundError(input.interactionId);
  }
  const plan = current.plan as InteractionPlan;
  const slots =
    current.slots && typeof current.slots === "object" && !Array.isArray(current.slots)
      ? (current.slots as Record<string, unknown>)
      : {};
  const confirmed = confirmInteractionDraftState(
    {
      status: current.status as InteractionLifecycleStatus,
      draftVersion: current.draftVersion,
      confirmedVersion: current.confirmedVersion,
      plan,
      slots,
    },
    input.draftVersion,
  );
  if (!confirmed.ok) {
    if (confirmed.error === "version_conflict") {
      throw new InteractionVersionConflictError(
        input.interactionId,
        input.draftVersion,
        current.draftVersion,
      );
    }
    throw new Error(confirmed.message);
  }

  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.interaction.updateMany({
        where: { id: input.interactionId, draftVersion: input.draftVersion },
        data: {
          confirmedVersion: confirmed.confirmedVersion,
          status: confirmed.status,
          ...(input.approvalEffectId ? { approvalEffectId: input.approvalEffectId } : {}),
        },
      });
      if (updated.count !== 1) {
        throw new InteractionVersionConflictError(
          input.interactionId,
          input.draftVersion,
          current.draftVersion,
        );
      }
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.interaction.updated",
        runId: current.runId ?? undefined,
        payload: {
          interactionId: input.interactionId,
          draftVersion: current.draftVersion,
          confirmedVersion: confirmed.confirmedVersion,
          approvalEffectId: input.approvalEffectId,
          messageId: current.messageId ?? undefined,
        },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.interaction.approval_requested",
        runId: current.runId ?? undefined,
        payload: {
          interactionId: input.interactionId,
          draftVersion: current.draftVersion,
          confirmedVersion: confirmed.confirmedVersion,
          approvalEffectId: input.approvalEffectId,
          messageId: current.messageId ?? undefined,
        },
      });
    }),
  );

  return { confirmedVersion: confirmed.confirmedVersion };
}
