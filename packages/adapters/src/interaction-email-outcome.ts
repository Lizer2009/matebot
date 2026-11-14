import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import {
  batchResultRows,
  buildResultSurface,
  closedSurfaceReasonKey,
  emailSurfaceBlockFields,
  surfaceReasonKeyForApproval,
} from "@matebot/core";
import type { Prisma, PrismaClient } from "@matebot/db";
import { appendEventInTransaction, withTransactionRetry } from "@matebot/db";
import { senderStampFromBlock } from "./interaction-publish.js";

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
  /** Absent means this draft has never been confirmed; never guessed. */
  confirmedVersion?: number | null;
  draftVersion: number;
  /** The run that owns this surface, when one is still bound. */
  runId?: string;
  spaceId: string;
  threadId: string;
  botId: string;
  interactionStatus: InteractionLifecycleStatus;
  effectStatus?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
  approvalEffectId?: string;
  /** Mailbox three-state; refreshed on a reauth failure so the card stays actionable. */
  capability?: EmailSurfaceCapability;
  /** Closed-set reason when the card is waiting for approval. */
  reasonKey?: string;
  actionEvent?:
    | "thread.interaction.action_started"
    | "thread.interaction.action_progress"
    | "thread.interaction.action_succeeded"
    | "thread.interaction.action_failed";
  progress?: string;
  /**
   * Per-item outcomes of a batch. When present, the surface the draft already
   * owns is republished as a result document with one row per requested item, so
   * a partial batch is readable on the card itself (§5.4.2) rather than only in
   * the stored effect payload.
   */
  batch?: {
    items: Array<{ label: string; state: "succeeded" | "failed" | "unknown"; error?: string }>;
    notice: string;
  };
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
  const capability = input.capability ?? capabilityFromBlocks(existing, surfaceRow?.surfaceId);
  const stamps = emailSurfaceBlockFields({
    intent: input.plan.intent,
    capability,
    interactionStatus: input.interactionStatus,
    effectStatus: input.effectStatus,
    providerMessageId: input.providerMessageId,
    error: input.error,
  });
  if (surfaceRow && input.batch) {
    // Rewrite the document this card already points at, in place: the same
    // surfaceId, the same message, a result rendering of what actually happened.
    const batchDocument = await batchResultDocument(input.batch);
    if (batchDocument) {
      await tx.interactionSurface.upsert({
        where: {
          interactionId_surfaceId: {
            interactionId: input.interaction.id,
            surfaceId: surfaceRow.surfaceId,
          },
        },
        create: {
          interactionId: input.interaction.id,
          surfaceId: surfaceRow.surfaceId,
          protocolFamily: protocolFamilyOf(surfaceRow.protocolFamily),
          document: batchDocument as Prisma.InputJsonValue,
          draftVersion: input.draftVersion,
        },
        update: {
          document: batchDocument as Prisma.InputJsonValue,
          draftVersion: input.draftVersion,
        },
      });
    }
  }
  if (surfaceRow && message && input.interaction.messageId) {
    const protocolFamily = protocolFamilyOf(surfaceRow.protocolFamily);
    const documentRef = a2uiSurfaceDocumentRef({
      interactionId: input.interaction.id,
      surfaceId: surfaceRow.surfaceId,
    });
    // The card keeps the connection's label across a confirm, an execute or a progress stamp;
    // rebuilding without it would blank the read-only sender row mid-lifecycle.
    const senderStamp = senderStampFromBlock(existing, surfaceRow.surfaceId);
    const block: MessageBlock = {
      kind: "a2ui_surface",
      interactionId: input.interaction.id,
      surfaceId: surfaceRow.surfaceId,
      protocolFamily,
      draftVersion: input.draftVersion,
      ...(input.confirmedVersion ? { confirmedVersion: input.confirmedVersion } : {}),
      intent: input.plan.intent,
      title: input.interaction.title ?? input.plan.title,
      ...(input.interaction.summary || input.plan.summary
        ? { summary: input.interaction.summary ?? input.plan.summary }
        : {}),
      documentRef,
      ...(senderStamp.senderLabel ? { senderLabel: senderStamp.senderLabel } : {}),
      ...(senderStamp.senderAddress ? { senderAddress: senderStamp.senderAddress } : {}),
      ...stamps,
      ...(input.interactionStatus === "awaiting_approval"
        ? {
            reasonKey:
              closedSurfaceReasonKey(input.reasonKey) ??
              surfaceReasonKeyForApproval({ scope: "setting" }),
          }
        : {}),
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
        ...(input.confirmedVersion ? { confirmedVersion: input.confirmedVersion } : {}),
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
      ...(input.confirmedVersion ? { confirmedVersion: input.confirmedVersion } : {}),
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
        ...(input.confirmedVersion ? { confirmedVersion: input.confirmedVersion } : {}),
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
  /** Refreshed mailbox three-state, so a revoked account turns the card into reconnect. */
  capability?: EmailSurfaceCapability;
  /** When set, a concurrent writer that already left `ambiguous` wins once. */
  expectedEffectStatus?: string;
  /** Per-item outcomes, when the effect ran a batch. */
  batch?: {
    items: Array<{ label: string; state: "succeeded" | "failed" | "unknown"; error?: string }>;
    notice: string;
  };
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
        ...(input.capability ? { capability: input.capability } : {}),
        ...(input.batch ? { batch: input.batch } : {}),
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

/**
 * The document for a batch's outcomes, in the same catalog the card already uses.
 *
 * One row per requested item, plus the count summary as the title. Built from the
 * recorded outcomes, so the card cannot say more happened than did.
 */
async function batchResultDocument(batch: {
  items: Array<{ label: string; state: "succeeded" | "failed" | "unknown"; error?: string }>;
  notice: string;
}): Promise<unknown[] | null> {
  const rows = batchResultRows(batch.items);
  const built = buildResultSurface({
    title: batch.notice,
    provenance: { source: "Calendar", asOf: new Date().toISOString(), attribution: "source" },
    columns: rows.columns,
    rows: rows.rows,
  });
  if (!built.ok) return null;
  const { compileInteractionSurface } = await import("@matebot/a2ui-adapter");
  const compiled = await compileInteractionSurface({
    schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
    values: {},
    surfaceId: "batch-result",
    result: built.surface,
    title: built.surface.title,
  });
  return compiled.ok ? compiled.messages : null;
}
