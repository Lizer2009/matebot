import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import type {
  EmailSurfaceCapability,
  InteractionLifecycleStatus,
  InteractionStatus,
} from "@matebot/core";
import {
  emailSurfaceBlockFields,
  expiresAtFor,
  interactionCapabilityForIntent,
  interactionCardKey,
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
import type { OpenCardRow } from "./interaction-kernel-store.js";
import { findOpenCard, settleInteraction } from "./interaction-kernel-store.js";

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
  /**
   * A row can only be created in a status both vocabularies know: the older runtime lifecycle
   * still says `executing`, which the canonical card vocabulary does not contain.
   */
  status?: Extract<InteractionLifecycleStatus, InteractionStatus>;
  /**
   * The executed record this surface corrects. Set only when a new draft amends
   * a record that already ran; the original row is never rewritten.
   */
  amendsInteractionId?: string;
  /** sha256(threadId + NUL + intent); see the partial unique index. */
  cardKey?: string;
  /** Set only for `awaiting_approval`; see `expiresAtFor`. */
  expiresAt?: Date | null;
  /** The connection's own label, shown read-only on the card. Never an address. */
  senderLabel?: string;
  /** Provider mailbox, only when the server learned it from the account record. */
  senderAddress?: string;
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

const MAX_SENDER_ADDRESS_LENGTH = 254;

function senderAddressForBlock(address: string | undefined): string | undefined {
  const trimmed = address?.trim();
  if (!trimmed || trimmed.length > MAX_SENDER_ADDRESS_LENGTH) return undefined;
  if (!trimmed.includes("@") || /\s/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Carry the sender label over when a card is rewritten in place.
 *
 * Every in-place rewrite rebuilds the block from its new stamps, so a rebuild that does not copy
 * this drops the card's read-only "sending from" row — it blanks out after a confirm, an execute
 * or a progress update, not just after an edit. The label never changes as a card moves through
 * its lifecycle, so the block being replaced is always the right source.
 */
export function senderStampFromBlock(
  blocks: MessageBlock[] | undefined,
  surfaceId: string | undefined,
): { senderLabel?: string; senderAddress?: string } {
  if (!blocks) return {};
  for (const entry of blocks) {
    if (entry.kind !== "a2ui_surface") continue;
    if (surfaceId && entry.surfaceId !== surfaceId) continue;
    return {
      ...(entry.senderLabel ? { senderLabel: entry.senderLabel } : {}),
      ...(entry.senderAddress ? { senderAddress: entry.senderAddress } : {}),
    };
  }
  return {};
}

export function senderLabelFromBlock(
  blocks: MessageBlock[] | undefined,
  surfaceId: string | undefined,
): string | undefined {
  return senderStampFromBlock(blocks, surfaceId).senderLabel;
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
  const senderAddress = senderAddressForBlock(input.senderAddress);
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
        ...(input.cardKey ? { cardKey: input.cardKey } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
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
        ...(senderAddress ? { senderAddress } : {}),
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

export type PublishOrAmendInput = PublishInteractionSurfaceInput;

export type PublishOrAmendResult = {
  interactionId: string;
  surfaceId: string;
  messageId: string;
  documentRef: string;
  draftVersion: number;
  eventSeq: number;
  /** True when an existing card was rewritten in place. */
  amended: boolean;
  missingRequired: string[];
  plan: InteractionPlan;
  slots: Record<string, unknown>;
  capability?: EmailSurfaceCapability;
};

/**
 * Publish, or rewrite the card already on screen.
 *
 * `publishInteractionSurface` always creates a row and a message, which is why a
 * second present of the same intent used to leave two live buttons for one
 * effect. This wraps it: a live card for the same (thread, intent) is rewritten
 * in place — row, surface document and the message block that carries it — and
 * only an absent card creates anything.
 *
 * A `P2002` on insert means another run won the race; the retry re-reads and
 * amends, which is the same outcome the loser wanted.
 */
export async function publishOrAmend(
  prisma: PrismaClient,
  input: PublishOrAmendInput,
): Promise<PublishOrAmendResult> {
  const cardKey = input.cardKey ?? interactionCardKey(input.threadId, input.plan.intent);
  const status = input.status ?? "collecting";
  // An explicit `null` is a decision (no expiry), not a request to derive one.
  const expiresAt = input.expiresAt === undefined ? expiresAtFor(status) : input.expiresAt;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await findOpenCard(prisma, {
      threadId: input.threadId,
      intent: input.plan.intent,
    });
    if (existing?.messageId) {
      return amendPublishedCard(prisma, {
        ...input,
        status,
        expiresAt,
        existing,
        messageId: existing.messageId,
      });
    }
    if (existing) {
      // A live row with no message is holding the card key while showing nothing.
      // Leaving it in place would make every insert race it forever, so close it
      // and let the new card create.
      await settleInteraction(prisma, {
        interactionId: existing.id,
        status: "superseded",
        reason: "card had no message",
      });
    }
    try {
      const published = await publishInteractionSurface(prisma, { ...input, cardKey, expiresAt });
      return { ...published, amended: false };
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002" || attempt > 0) throw error;
      getLogger().info("interaction.publish_race_retry", {
        "interaction.card_key": cardKey,
        "interaction.intent": input.plan.intent,
      });
    }
  }
  throw new Error("Could not publish or amend the interaction card");
}

/**
 * Rewrite the card a person is already looking at.
 *
 * The message block is replaced in place. Appending a second message is the
 * behaviour this function exists to end.
 */
async function amendPublishedCard(
  prisma: PrismaClient,
  input: PublishOrAmendInput & {
    existing: OpenCardRow;
    messageId: string;
    expiresAt: Date | null;
  },
): Promise<PublishOrAmendResult> {
  const { existing } = input;
  // Rewrite the surface the card already points at. A new id here would insert a
  // second surface row, and the client keys blocks by `interactionId:surfaceId`,
  // so the person would see the old card and the new one side by side — the very
  // duplicate this function exists to prevent.
  const latestSurface = await prisma.interactionSurface.findFirst({
    where: { interactionId: existing.id },
    orderBy: { updatedAt: "desc" },
    select: { surfaceId: true },
  });
  const surfaceId =
    input.surfaceId?.trim() || latestSurface?.surfaceId || `surface-${crypto.randomUUID()}`;
  const emailIntent = input.plan.intent === "email.compose" || input.plan.intent === "email.send";
  const senderLabel = senderLabelForBlock(input.senderLabel);
  const senderAddress = senderAddressForBlock(input.senderAddress);
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
  const reconciledPlan = compiled.plan ?? input.plan;
  const slots = interactionSlotsFromPlan(reconciledPlan);
  const nextVersion = existing.draftVersion + 1;

  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.interaction.update({
        where: { id: existing.id },
        data: {
          plan: reconciledPlan as never,
          slots: slots as never,
          title: reconciledPlan.title ?? null,
          summary: reconciledPlan.summary ?? null,
          status: input.status ?? "collecting",
          draftVersion: nextVersion,
          staleAt: null,
          expiresAt: input.expiresAt,
        },
      });
      const { documentRef } = await upsertInteractionSurface(tx, {
        interactionId: existing.id,
        surfaceId,
        protocolFamily: compiled.protocolFamily,
        document: compiled.messages,
        draftVersion: nextVersion,
      });
      const message = await tx.message.findUnique({
        where: { id: input.messageId },
        select: { blocks: true },
      });
      const previous = Array.isArray(message?.blocks) ? (message.blocks as MessageBlock[]) : [];
      // The block being replaced is the only place the read-only "sending from"
      // row can come from; a rebuild that trusts only this call's arguments
      // blanks it on every amend.
      const carried = senderStampFromBlock(previous, surfaceId);
      const blockLabel = senderLabel ?? carried.senderLabel;
      const blockAddress = senderAddress ?? carried.senderAddress;
      const block: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: existing.id,
        surfaceId,
        protocolFamily: compiled.protocolFamily,
        draftVersion: nextVersion,
        intent: input.plan.intent,
        title: input.plan.title,
        summary: input.plan.summary,
        documentRef,
        ...(input.amendsInteractionId ? { amendsInteractionId: input.amendsInteractionId } : {}),
        ...(blockLabel ? { senderLabel: blockLabel } : {}),
        ...(blockAddress ? { senderAddress: blockAddress } : {}),
        ...stamps,
      };
      const nextBlocks = previous.some(
        (entry) => entry.kind === "a2ui_surface" && entry.interactionId === existing.id,
      )
        ? previous.map((entry) =>
            entry.kind === "a2ui_surface" && entry.interactionId === existing.id ? block : entry,
          )
        : [...previous, block];
      await tx.message.update({
        where: { id: input.messageId },
        data: { blocks: nextBlocks as never },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.updated",
        runId: input.runId,
        lease: input.lease,
        payload: { messageId: input.messageId, role: "bot", blocks: nextBlocks },
      });
      return {
        interactionId: existing.id,
        surfaceId,
        messageId: input.messageId,
        documentRef,
        draftVersion: nextVersion,
        eventSeq: event.seq,
        amended: true,
        missingRequired: compiled.missingRequired,
        plan: reconciledPlan,
        slots,
        ...(input.capability ? { capability: input.capability } : {}),
      };
    }),
  );
}
