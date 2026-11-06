import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import { applyInteractionFieldChange, emailSurfaceBlockFields } from "@matebot/core";
import type { Prisma, PrismaClient } from "@matebot/db";
import {
  appendEventInTransaction,
  getInteraction,
  InteractionNotFoundError,
  InteractionVersionConflictError,
  upsertInteractionSurface,
  withTransactionRetry,
} from "@matebot/db";

/**
 * The single write path for an interaction field.
 *
 * It lives below both callers because the card's own controls and the model's
 * `edit_interaction` tool must not diverge: one bumps the revision, recompiles
 * the surface, and republishes it; two implementations eventually disagree.
 * Neither sends — that stays the card's own Send gesture.
 */

function isEmailPlan(plan: InteractionPlan): boolean {
  return plan.intent === "email.compose" || plan.intent === "email.send";
}

function protocolFamilyOf(value: string): A2uiProtocolFamily {
  return value === "v1_0" || value === "v0_9" ? value : "v0_9";
}

function capabilityFromBlocks(
  blocks: MessageBlock[] | undefined,
  surfaceId?: string,
): EmailSurfaceCapability | undefined {
  if (!blocks) return undefined;
  for (const entry of blocks) {
    if (entry.kind !== "a2ui_surface") continue;
    if (surfaceId && entry.surfaceId !== surfaceId) continue;
    if (entry.capability) return entry.capability;
  }
  return undefined;
}

async function compilePlanSurface(input: {
  plan: InteractionPlan;
  surfaceId: string;
  protocolFamily?: A2uiProtocolFamily;
  capability?: EmailSurfaceCapability;
  interactionStatus: InteractionLifecycleStatus;
  effectStatus?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
}): Promise<{ protocolFamily: A2uiProtocolFamily; messages: unknown[] }> {
  const stamps = isEmailPlan(input.plan)
    ? emailSurfaceBlockFields({
        intent: input.plan.intent,
        capability: input.capability,
        interactionStatus: input.interactionStatus,
        effectStatus: input.effectStatus,
        providerMessageId: input.providerMessageId,
        error: input.error,
      })
    : {};
  const { compileInteractionPlan } = await import("@matebot/a2ui-adapter");
  const compiled = await compileInteractionPlan({
    plan: input.plan,
    surfaceId: input.surfaceId,
    protocolFamily: input.protocolFamily ?? "v0_9",
    ...stamps,
  });
  if (!compiled.ok) {
    throw new Error(compiled.error);
  }
  return { protocolFamily: compiled.protocolFamily, messages: compiled.messages };
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

  const currentMessage = current.messageId
    ? await prisma.message.findUnique({ where: { id: current.messageId } })
    : null;
  const currentBlocks = Array.isArray(currentMessage?.blocks)
    ? (currentMessage.blocks as MessageBlock[])
    : undefined;
  const capability = capabilityFromBlocks(currentBlocks, surfaceRow.surfaceId);
  const compiled = await compilePlanSurface({
    plan: changed.plan,
    surfaceId: surfaceRow.surfaceId,
    protocolFamily: protocolFamilyOf(surfaceRow.protocolFamily),
    capability,
    interactionStatus: changed.status,
  });
  const stamps = isEmailPlan(changed.plan)
    ? emailSurfaceBlockFields({
        intent: changed.plan.intent,
        capability,
        interactionStatus: changed.status,
      })
    : {};

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
        intent: changed.plan.intent,
        title: changed.plan.title,
        summary: changed.plan.summary,
        documentRef,
        ...stamps,
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
          intent: changed.plan.intent,
          title: changed.plan.title,
          summary: changed.plan.summary,
          documentRef: a2uiSurfaceDocumentRef({
            interactionId: input.interactionId,
            surfaceId: surfaceRow.surfaceId,
          }),
          messageId: current.messageId ?? undefined,
          ...stamps,
        },
      });
    }),
  );

  return { draftVersion: changed.draftVersion };
}
