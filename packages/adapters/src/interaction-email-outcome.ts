import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import { emailSurfaceBlockFields } from "@matebot/core";
import type { Prisma, PrismaClient } from "@matebot/db";
import { appendEventInTransaction, withTransactionRetry } from "@matebot/db";

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

function protocolFamilyOf(value: string): A2uiProtocolFamily {
  return value === "v1_0" || value === "v0_9" ? value : "v0_9";
}

export type ProjectInteractionEmailSurfaceInput = {
  interaction: {
    id: string;
    messageId: string | null;
    title: string | null;
    summary: string | null;
  };
  plan: InteractionPlan;
  confirmedVersion: number;
  draftVersion: number;
  runId: string;
  spaceId: string;
  threadId: string;
  botId: string;
  interactionStatus: InteractionLifecycleStatus;
  effectStatus?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
  approvalEffectId?: string;
  actionEvent?:
    | "thread.interaction.action_started"
    | "thread.interaction.action_progress"
    | "thread.interaction.action_succeeded"
    | "thread.interaction.action_failed";
  progress?: string;
};

/** Patch the existing email surface and emit the SSE the card already listens to. */
export async function projectInteractionEmailSurface(
  tx: Prisma.TransactionClient,
  input: ProjectInteractionEmailSurfaceInput,
): Promise<void> {
  const surfaceRow = await tx.interactionSurface.findFirst({
    where: { interactionId: input.interaction.id },
    orderBy: { updatedAt: "desc" },
  });
  const message = input.interaction.messageId
    ? await tx.message.findUnique({ where: { id: input.interaction.messageId } })
    : null;
  const existing = Array.isArray(message?.blocks) ? (message.blocks as MessageBlock[]) : [];
  const capability = capabilityFromBlocks(existing, surfaceRow?.surfaceId);
  const stamps = emailSurfaceBlockFields({
    intent: input.plan.intent,
    capability,
    interactionStatus: input.interactionStatus,
    effectStatus: input.effectStatus,
    providerMessageId: input.providerMessageId,
    error: input.error,
  });
  if (surfaceRow && message && input.interaction.messageId) {
    const protocolFamily = protocolFamilyOf(surfaceRow.protocolFamily);
    const documentRef = a2uiSurfaceDocumentRef({
      interactionId: input.interaction.id,
      surfaceId: surfaceRow.surfaceId,
    });
    const block: MessageBlock = {
      kind: "a2ui_surface",
      interactionId: input.interaction.id,
      surfaceId: surfaceRow.surfaceId,
      protocolFamily,
      draftVersion: input.draftVersion,
      confirmedVersion: input.confirmedVersion,
      intent: input.plan.intent,
      title: input.interaction.title ?? input.plan.title,
      ...(input.interaction.summary || input.plan.summary
        ? { summary: input.interaction.summary ?? input.plan.summary }
        : {}),
      documentRef,
      ...stamps,
    };
    const blocks = existing.map((entry) =>
      entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId ? block : entry,
    );
    const has = blocks.some(
      (entry) => entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId,
    );
    const nextBlocks = has ? blocks : [...blocks, block];
    await tx.message.update({
      where: { id: input.interaction.messageId },
      data: { blocks: nextBlocks as Prisma.InputJsonValue },
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.updated",
      runId: input.runId,
      payload: { messageId: input.interaction.messageId, role: "bot", blocks: nextBlocks },
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.surface.updated",
      runId: input.runId,
      payload: {
        interactionId: input.interaction.id,
        surfaceId: surfaceRow.surfaceId,
        protocolFamily,
        draftVersion: input.draftVersion,
        confirmedVersion: input.confirmedVersion,
        intent: input.plan.intent,
        title: block.title,
        summary: block.summary,
        documentRef,
        messageId: input.interaction.messageId,
        ...stamps,
      },
    });
  }
  await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    type: "thread.interaction.updated",
    runId: input.runId,
    payload: {
      interactionId: input.interaction.id,
      intent: input.plan.intent,
      draftVersion: input.draftVersion,
      confirmedVersion: input.confirmedVersion,
      progress: input.progress ?? stamps.lifecycle,
      error: stamps.error,
      template: stamps.template,
      lifecycle: stamps.lifecycle,
      providerMessageId: stamps.providerMessageId,
      approvalEffectId: input.approvalEffectId,
      messageId: input.interaction.messageId ?? undefined,
    },
  });
  if (input.actionEvent) {
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.actionEvent,
      runId: input.runId,
      payload: {
        interactionId: input.interaction.id,
        draftVersion: input.draftVersion,
        confirmedVersion: input.confirmedVersion,
        progress: input.progress ?? stamps.lifecycle,
        error: stamps.error,
        template: stamps.template,
        lifecycle: stamps.lifecycle,
        providerMessageId: stamps.providerMessageId,
        messageId: input.interaction.messageId ?? undefined,
      },
    });
  }
}

export type FinishInteractionEmailSendInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  interaction: {
    id: string;
    messageId: string | null;
    title: string | null;
    summary: string | null;
  };
  plan: InteractionPlan;
  draftVersion: number;
  confirmedVersion: number;
  effectId: string;
  runId: string;
  effectStatus: "completed" | "reconciled" | "failed" | "ambiguous";
  interactionStatus: "succeeded" | "failed" | "unknown";
  result: Record<string, unknown>;
  /** When set, a concurrent writer that already left `ambiguous` wins once. */
  expectedEffectStatus?: string;
};

export async function finishInteractionEmailSend(
  prisma: PrismaClient,
  input: FinishInteractionEmailSendInput,
): Promise<boolean> {
  const providerMessageId =
    typeof input.result.providerMessageId === "string"
      ? input.result.providerMessageId
      : typeof input.result.deliveryId === "string"
        ? input.result.deliveryId
        : undefined;
  const error = typeof input.result.error === "string" ? input.result.error : undefined;
  const actionEvent =
    input.interactionStatus === "succeeded"
      ? ("thread.interaction.action_succeeded" as const)
      : input.interactionStatus === "unknown"
        ? ("thread.interaction.action_progress" as const)
        : ("thread.interaction.action_failed" as const);
  let applied = false;
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.externalEffect.updateMany({
        where: {
          id: input.effectId,
          ...(input.expectedEffectStatus ? { status: input.expectedEffectStatus } : {}),
        },
        data: {
          status: input.effectStatus,
          result: input.result as Prisma.InputJsonValue,
        },
      });
      if (updated.count !== 1) return;
      await tx.interaction.updateMany({
        where: { id: input.interaction.id, draftVersion: input.draftVersion },
        data: { status: input.interactionStatus },
      });
      await projectInteractionEmailSurface(tx, {
        interaction: input.interaction,
        plan: input.plan,
        confirmedVersion: input.confirmedVersion,
        draftVersion: input.draftVersion,
        runId: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        interactionStatus: input.interactionStatus,
        effectStatus: input.effectStatus,
        providerMessageId,
        error,
        approvalEffectId: input.effectId,
        actionEvent,
        progress: input.interactionStatus,
      });
      applied = true;
    }),
  );
  return applied;
}

export function emailDraftSlots(request: unknown): { to: string; subject: string; body: string } {
  const record =
    request && typeof request === "object" && !Array.isArray(request)
      ? (request as { slots?: unknown }).slots
      : undefined;
  const slots =
    record && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : {};
  const text = (name: string) => (typeof slots[name] === "string" ? slots[name] : "");
  return { to: text("to"), subject: text("subject"), body: text("body") };
}
