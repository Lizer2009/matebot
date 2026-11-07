import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import { emailSurfaceBlockFields, interactionSlotsFromPlan, timingFields } from "@matebot/core";
import type { PrismaClient, RunLease } from "@matebot/db";
import {
  appendEventInTransaction,
  createInteraction,
  createThreadMessageInTransaction,
  upsertInteractionSurface,
  withTransactionRetry,
} from "@matebot/db";
import { getLogger } from "@matebot/logging";

async function compilePlanSurface(input: {
  plan: InteractionPlan;
  surfaceId: string;
  protocolFamily?: A2uiProtocolFamily;
  capability?: EmailSurfaceCapability;
  status?: InteractionLifecycleStatus;
}): Promise<{ protocolFamily: A2uiProtocolFamily; messages: unknown[] }> {
  const emailIntent = input.plan.intent === "email.compose" || input.plan.intent === "email.send";
  const stamps = emailIntent
    ? emailSurfaceBlockFields({
        intent: input.plan.intent,
        capability: input.capability,
        interactionStatus: input.status ?? "collecting",
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

export type PublishInteractionSurfaceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId?: string;
  plan: InteractionPlan;
  surfaceId?: string;
  protocolFamily?: A2uiProtocolFamily;
  /** When publishing from an active run, bind history writes to that attempt's lease. */
  lease?: RunLease;
  /** Mailbox preflight stamp; omitted on non-email surfaces. */
  capability?: EmailSurfaceCapability;
  status?: InteractionLifecycleStatus;
  /**
   * The executed record this surface corrects. Set only when a new draft amends
   * a record that already ran; the original row is never rewritten.
   */
  amendsInteractionId?: string;
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
  eventSeq: number;
  capability?: EmailSurfaceCapability;
}> {
  const surfaceId = input.surfaceId?.trim() || `surface-${crypto.randomUUID()}`;
  const emailIntent = input.plan.intent === "email.compose" || input.plan.intent === "email.send";
  const stamps = emailIntent
    ? emailSurfaceBlockFields({
        intent: input.plan.intent,
        capability: input.capability,
        interactionStatus: input.status ?? "collecting",
      })
    : {};
  const compiled = await compilePlanSurface({
    plan: input.plan,
    surfaceId,
    protocolFamily: input.protocolFamily,
    capability: emailIntent ? input.capability : undefined,
    status: input.status,
  });
  const slots = interactionSlotsFromPlan(input.plan);

  const publishedAt = Date.now();
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const interaction = await createInteraction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        runId: input.runId,
        intent: input.plan.intent,
        status: input.status ?? "collecting",
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
        intent: input.plan.intent,
        title: input.plan.title,
        summary: input.plan.summary,
        documentRef,
        ...(input.amendsInteractionId ? { amendsInteractionId: input.amendsInteractionId } : {}),
        ...stamps,
      };
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks: [block],
        botId: input.botId,
        runId: input.runId,
        lease: input.lease,
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
        lease: input.lease,
        payload: { messageId: message.id, role: "bot", blocks: [block] },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.interaction.created",
        runId: input.runId,
        lease: input.lease,
        payload: {
          interactionId: interaction.id,
          intent: interaction.intent,
          draftVersion: interaction.draftVersion,
          title: interaction.title,
          summary: interaction.summary,
          messageId: message.id,
        },
      });
      const surfaceEvent = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.surface.created",
        runId: input.runId,
        lease: input.lease,
        payload: {
          interactionId: interaction.id,
          surfaceId,
          protocolFamily: compiled.protocolFamily,
          draftVersion: interaction.draftVersion,
          intent: input.plan.intent,
          title: input.plan.title,
          summary: input.plan.summary,
          documentRef,
          messageId: message.id,
          ...stamps,
        },
      });
      // §9.6 instrumentation: the surface the user can now see. Measured from
      // the start of the publish, so it is the server's own work, not the model's.
      getLogger().info("a2ui.surface_visible", {
        ...timingFields({
          metric: "surface-visible",
          ms: Math.max(0, Date.now() - publishedAt),
          origin: "run-created",
        }),
        "interaction.id": interaction.id,
        "surface.id": surfaceId,
        "surface.intent": input.plan.intent,
        "surface.draft_version": interaction.draftVersion,
      });
      return {
        interactionId: interaction.id,
        surfaceId,
        messageId: message.id,
        documentRef,
        draftVersion: interaction.draftVersion,
        eventSeq: surfaceEvent.seq,
        ...(input.capability ? { capability: input.capability } : {}),
      };
    }),
  );
}
