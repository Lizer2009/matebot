import { reconcilePlanToSchema } from "@matebot/a2ui-adapter";
import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import {
  applyInteractionFieldChange,
  decideCancel,
  emailSurfaceBlockFields,
  interactionCapabilityForIntent,
  interactionSlotsFromPlan,
} from "@matebot/core";
import type { Prisma, PrismaClient } from "@matebot/db";
import {
  appendEventInTransaction,
  getInteraction,
  InteractionNotFoundError,
  InteractionVersionConflictError,
  upsertInteractionSurface,
  withTransactionRetry,
} from "@matebot/db";
import { getLogger } from "@matebot/logging";
import { senderLabelFromBlock } from "./interaction-publish.js";

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
  /**
   * The field this republish was triggered by. It wins over any other spelling of the same
   * name, so an edit to a row that still holds two spellings is not mistaken for a conflict.
   */
  changedField?: string;
}): Promise<{
  protocolFamily: A2uiProtocolFamily;
  messages: unknown[];
  plan: InteractionPlan;
}> {
  // The same reconciliation the publish path applies. An edit republishes the card, and without
  // this the row would drift back to the model's spellings on the first keystroke.
  const schema = interactionCapabilityForIntent(input.plan.intent)?.schema;
  const reconciled = reconcilePlanToSchema(input.plan, schema, {
    ...(input.changedField ? { prefer: [input.changedField] } : {}),
  });
  if (reconciled.conflict) {
    throw new Error(
      `conflicting values for field "${reconciled.conflict}"; edit the card instead of replacing it`,
    );
  }
  if (reconciled.oversizedField) {
    throw new Error(`field "${reconciled.oversizedField}" carries more data than a draft may hold`);
  }
  const plan = reconciled.plan;
  const stamps = isEmailPlan(plan)
    ? emailSurfaceBlockFields({
        intent: plan.intent,
        capability: input.capability,
        interactionStatus: input.interactionStatus,
        effectStatus: input.effectStatus,
        providerMessageId: input.providerMessageId,
        error: input.error,
      })
    : {};
  const { compileInteractionPlan } = await import("@matebot/a2ui-adapter");
  const compiled = await compileInteractionPlan({
    plan,
    surfaceId: input.surfaceId,
    protocolFamily: input.protocolFamily ?? "v0_9",
    ...(schema ? { schema } : {}),
    ...stamps,
  });
  if (!compiled.ok) {
    throw new Error(compiled.error);
  }
  return { protocolFamily: compiled.protocolFamily, messages: compiled.messages, plan };
}
export type UpdateInteractionFieldServiceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  interactionId: string;
  expectedDraftVersion: number;
  name: string;
  value: unknown;
  /**
   * `user` for a control the person drove, `model` (default) for a tool edit.
   * The stamp is persisted on the field so a later model edit can skip it.
   */
  origin?: "user" | "model";
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
      origin: input.origin,
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
    changedField: input.name,
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
          // Both the plan and the slots are stored in the schema's spelling: the confirm gate
          // looks values up by that name on the next turn.
          slots: interactionSlotsFromPlan(compiled.plan) as Prisma.InputJsonValue,
          plan: compiled.plan as Prisma.InputJsonValue,
          draftVersion: changed.draftVersion,
          confirmedVersion: null,
          status: changed.status,
          title: compiled.plan.title,
          summary: compiled.plan.summary,
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
      // What the card already says about itself, so a rebuild keeps the parts this write does
      // not own.
      const previousBlock = (Array.isArray(currentBlocks) ? currentBlocks : []).find(
        (entry): entry is Extract<MessageBlock, { kind: "a2ui_surface" }> =>
          entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId,
      );
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
        // The connection's label is not part of what an edit changes; a rebuild that dropped it
        // would leave the card's read-only sender row blank after the first keystroke.
        ...(previousBlock?.senderLabel ? { senderLabel: previousBlock.senderLabel } : {}),
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

export type CancelInteractionServiceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  interactionId: string;
  expectedDraftVersion: number;
  /** True when the caller's runtime can abort a running effect. */
  runtimeCanAbort?: boolean;
};

export class InteractionCancelRejectedError extends Error {
  constructor(
    readonly reason: "already_executed" | "in_flight" | "terminal",
    message: string,
  ) {
    super(message);
    this.name = "InteractionCancelRejectedError";
  }
}

/**
 * Cancel a draft that has not run.
 *
 * The decision comes from the recorded status, not from the request: a record
 * that executed keeps its status and its effect, and the caller is told plainly
 * that cancelling would not undo it. Nothing is deleted — a cancelled row is a
 * record of a draft the user withdrew, and its surface is republished in that
 * state so every client converges on the same thing.
 */
export async function cancelInteractionService(
  prisma: PrismaClient,
  input: CancelInteractionServiceInput,
): Promise<{ status: "cancelled"; draftVersion: number } | { status: "abort_requested" }> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current || current.threadId !== input.threadId) {
    throw new InteractionNotFoundError(input.interactionId);
  }
  if (current.draftVersion !== input.expectedDraftVersion) {
    throw new InteractionVersionConflictError(
      input.interactionId,
      input.expectedDraftVersion,
      current.draftVersion,
    );
  }
  const decision = decideCancel({
    status: current.status as InteractionLifecycleStatus,
    // An in-flight action resolves as an abort request rather than a refusal when
    // the caller's runtime can stop it; the caller checks that it actually did.
    runtimeCanAbort: input.runtimeCanAbort === true,
  });
  if (!decision.ok) throw new InteractionCancelRejectedError(decision.error, decision.message);
  if (decision.status === "abort_requested") {
    // The action is running. Cancelling the row now would record a withdrawal of
    // something that may already have happened, so the caller is told to abort
    // the effect instead; the effect then settles as failed or unknown by itself.
    return { status: "abort_requested" };
  }

  const plan = current.plan as InteractionPlan;
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
  // Cancelling must always work. A draft whose stored values no longer compile — an oversize
  // legacy field, a leftover conflict — is exactly the draft someone wants to get rid of, so a
  // compile failure here falls back to the existing document and still records the cancellation.
  const compiled = await compilePlanSurface({
    plan,
    surfaceId: surfaceRow.surfaceId,
    protocolFamily: protocolFamilyOf(surfaceRow.protocolFamily),
    capability,
    interactionStatus: "cancelled",
  }).catch((error: unknown) => {
    getLogger().warn("interaction cancel could not recompile; keeping the stored document", {
      "interaction.id": input.interactionId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  });
  const draftVersion = current.draftVersion + 1;

  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.interaction.updateMany({
        where: {
          id: input.interactionId,
          draftVersion: input.expectedDraftVersion,
          // Re-checked inside the transaction so a concurrent execute cannot slip
          // a started action past the decision made above.
          status: { notIn: ["executing", "succeeded", "unknown", "failed", "cancelled"] },
        },
        data: { status: "cancelled", confirmedVersion: null, draftVersion },
      });
      if (updated.count !== 1) {
        throw new InteractionCancelRejectedError(
          "in_flight",
          "这次操作已经在进行中或已经完成，不能再取消。",
        );
      }
      // With no recompiled document the row is still cancelled below; the card keeps the
      // document it already had, which is harmless because the status stamp is what a host
      // reads to stop offering the action.
      const documentRef = compiled
        ? (
            await upsertInteractionSurface(tx, {
              interactionId: input.interactionId,
              surfaceId: surfaceRow.surfaceId,
              protocolFamily: compiled.protocolFamily,
              document: compiled.messages,
              draftVersion,
            })
          ).documentRef
        : (current as { documentRef?: string }).documentRef;
      const cancelledBlock: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: input.interactionId,
        surfaceId: surfaceRow.surfaceId,
        protocolFamily: compiled?.protocolFamily ?? protocolFamilyOf(surfaceRow.protocolFamily),
        draftVersion,
        intent: plan.intent,
        title: plan.title,
        summary: plan.summary,
        ...(documentRef ? { documentRef } : {}),
        ...(isEmailPlan(plan)
          ? emailSurfaceBlockFields({
              intent: plan.intent,
              capability,
              interactionStatus: "cancelled",
            })
          : {}),
      };
      if (current.messageId) {
        const message = await tx.message.findUnique({ where: { id: current.messageId } });
        if (message) {
          const existing = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
          // A cancelled card still shows which mailbox it would have used; dropping the label
          // here would blank that row at the moment the person is deciding what to do next.
          const cancelledLabel = senderLabelFromBlock(existing, surfaceRow.surfaceId);
          const blocks = existing.map((entry) =>
            entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId
              ? cancelledLabel
                ? { ...cancelledBlock, senderLabel: cancelledLabel }
                : cancelledBlock
              : entry,
          );
          await tx.message.update({
            where: { id: current.messageId },
            data: { blocks: blocks as Prisma.InputJsonValue },
          });
          await appendEventInTransaction(tx, {
            spaceId: input.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            type: "thread.message.updated",
            runId: current.runId ?? undefined,
            payload: { messageId: current.messageId, role: "bot", blocks },
          });
        }
      }
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.surface.updated",
        runId: current.runId ?? undefined,
        payload: {
          interactionId: input.interactionId,
          surfaceId: surfaceRow.surfaceId,
          protocolFamily: compiled?.protocolFamily ?? protocolFamilyOf(surfaceRow.protocolFamily),
          draftVersion,
          intent: plan.intent,
          title: plan.title,
          summary: plan.summary,
          documentRef: a2uiSurfaceDocumentRef({
            interactionId: input.interactionId,
            surfaceId: surfaceRow.surfaceId,
          }),
          messageId: current.messageId ?? undefined,
          cancelled: true,
        },
      });
    }),
  );

  return { status: "cancelled", draftVersion };
}
