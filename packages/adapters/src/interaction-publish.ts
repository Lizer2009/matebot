import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import {
  emailSurfaceBlockFields,
  interactionCapabilityForIntent,
  interactionSlotsFromPlan,
  timingFields,
} from "@matebot/core";
import type { PrismaClient, RunLease } from "@matebot/db";
import {
  appendEventInTransaction,
  createInteraction,
  createThreadMessageInTransaction,
  upsertInteractionSurface,
  withTransactionRetry,
} from "@matebot/db";
import { getLogger } from "@matebot/logging";

/** The registered schema for an intent, when the capability is known. */
function capabilitySchema(intent: string) {
  return interactionCapabilityForIntent(intent)?.schema;
}

async function compilePlanSurface(input: {
  plan: InteractionPlan;
  surfaceId: string;
  protocolFamily?: A2uiProtocolFamily;
  capability?: EmailSurfaceCapability;
  status?: InteractionLifecycleStatus;
}): Promise<{
  protocolFamily: A2uiProtocolFamily;
  messages: unknown[];
  missingRequired: string[];
  /** The plan reconciled onto the registered schema, which is what the row must store. */
  plan: InteractionPlan;
}> {
  const emailIntent = input.plan.intent === "email.compose" || input.plan.intent === "email.send";
  const schema = capabilitySchema(input.plan.intent);
  const { compileInteractionPlan, reconcilePlanToSchema } = await import("@matebot/a2ui-adapter");
  const reconciled = reconcilePlanToSchema(input.plan, schema);
  if (reconciled.conflict) {
    // Two spellings of one field carrying different values: storing either would drop a value
    // the person may have typed, so the publish is refused before anything is written.
    throw new Error(
      `conflicting values for field "${reconciled.conflict}"; edit the card instead of replacing it`,
    );
  }
  if (reconciled.oversizedField) {
    // An undeclared field is data the action reads, and this one is larger than the row should
    // carry. Refusing here keeps it out of the stored document rather than truncating a value
    // the action would then act on.
    throw new Error(`field "${reconciled.oversizedField}" carries more data than a draft may hold`);
  }
  const plan = reconciled.plan;
  const stamps = emailIntent
    ? emailSurfaceBlockFields({
        intent: plan.intent,
        capability: input.capability,
        interactionStatus: input.status ?? "collecting",
      })
    : {};
  const compiled = await compileInteractionPlan({
    plan,
    surfaceId: input.surfaceId,
    protocolFamily: input.protocolFamily ?? "v0_9",
    // The registered capability's schema owns the form's labels and control kinds.
    ...(schema ? { schema } : {}),
    ...stamps,
  });
  if (!compiled.ok) {
    throw new Error(compiled.error);
  }
  return {
    protocolFamily: compiled.protocolFamily,
    messages: compiled.messages,
    missingRequired: compiled.missingRequired,
    plan,
  };
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
  /** The connection's own label, shown read-only on the card. Never an address. */
  senderLabel?: string;
};

/**
 * The longest sender label a block can carry.
 *
 * The connection row accepts any string at connect time, and the label shown on the card is
 * often a title the model wrote. A value past this bound would make the stored block fail to
 * parse on read, which loses the whole card rather than one line of it.
 */
const MAX_SENDER_LABEL_LENGTH = 80;

/** The label as the block may carry it: trimmed, and empty when it would not fit. */
function senderLabelForBlock(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed || trimmed.length > MAX_SENDER_LABEL_LENGTH) return undefined;
  return trimmed;
}

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
  /** Declared required fields with no value yet; the card is published and editable. */
  missingRequired: string[];
  /** The plan and slots as stored, for describing the card that was created. */
  plan: InteractionPlan;
  slots: Record<string, unknown>;
}> {
  const surfaceId = input.surfaceId?.trim() || `surface-${crypto.randomUUID()}`;
  const emailIntent = input.plan.intent === "email.compose" || input.plan.intent === "email.send";
  const senderLabel = senderLabelForBlock(input.senderLabel);
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
  // Store the reconciled plan and slots: the confirm gate and the card's own controls both read
  // these, so leaving the model's spellings here would compile a card that cannot be confirmed.
  const reconciledPlan = compiled.plan ?? input.plan;
  const slots = interactionSlotsFromPlan(reconciledPlan);

  const publishedAt = Date.now();
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const interaction = await createInteraction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        runId: input.runId,
        intent: reconciledPlan.intent,
        status: input.status ?? "collecting",
        plan: reconciledPlan,
        slots,
        title: reconciledPlan.title,
        summary: reconciledPlan.summary,
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
        // The connection's own label for the card's read-only "sending from" row. Not an
        // address, and never editable: the mailbox is decided by the connection.
        ...(senderLabel ? { senderLabel } : {}),
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
        missingRequired: compiled.missingRequired,
        // What was stored, so the caller can describe the card it actually created rather than
        // the plan it submitted.
        plan: reconciledPlan,
        slots,
      };
    }),
  );
}
