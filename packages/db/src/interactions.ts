import type { A2uiProtocolFamily, InteractionPlan } from "@matebot/contracts";
import {
  a2uiSurfaceDocumentRef,
  InteractionPlanSchema,
  parseA2uiSurfaceDocumentRef,
} from "@matebot/contracts";
import type { InteractionStatus } from "@matebot/core";
import { interactionCardKey } from "@matebot/core/node/interaction-card-key";
import type { Prisma, PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

export type { InteractionStatus };

export type CreateInteractionInput = {
  spaceId: string;
  threadId: string;
  runId?: string;
  intent: string;
  status?: InteractionStatus;
  plan: InteractionPlan;
  slots?: Record<string, unknown>;
  title?: string;
  summary?: string;
  messageId?: string;
  /**
   * sha256(threadId + NUL + intent). Optional: omitted means `createInteraction` derives it from
   * this row's own thread and intent, so a new row never lacks one. The column is nullable only
   * until the previous release, which never writes it, has drained.
   */
  cardKey?: string;
  /** Set only for `awaiting_approval`. */
  expiresAt?: Date | null;
};

export type UpsertInteractionSurfaceInput = {
  interactionId: string;
  surfaceId: string;
  protocolFamily: A2uiProtocolFamily;
  document: unknown;
  draftVersion: number;
};

export type InteractionRow = {
  id: string;
  spaceId: string;
  threadId: string;
  runId: string | null;
  intent: string;
  status: string;
  cardKey: string | null;
  staleAt: Date | null;
  expiresAt: Date | null;
  draftVersion: number;
  confirmedVersion: number | null;
  plan: unknown;
  slots: unknown;
  title: string | null;
  summary: string | null;
  approvalEffectId: string | null;
  messageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InteractionSurfaceRow = {
  id: string;
  interactionId: string;
  surfaceId: string;
  protocolFamily: string;
  document: unknown;
  draftVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

function asSlots(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

/** Create a server-owned Interaction nested under Thread / optional Run. */
export async function createInteraction(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: CreateInteractionInput,
): Promise<InteractionRow> {
  const plan = InteractionPlanSchema.parse(input.plan);
  const slots =
    input.slots ??
    Object.fromEntries(
      plan.fields
        .filter((field) => field.value !== undefined)
        .map((field) => [field.name, field.value]),
    );
  return prisma.interaction.create({
    data: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      runId: input.runId,
      intent: input.intent,
      // Derive the key when the caller does not pass one, so every row written now is covered by
      // the partial unique index. The column stays nullable only until the previous release, which
      // never writes a key, has drained.
      cardKey: input.cardKey ?? interactionCardKey(input.threadId, input.intent),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      status: input.status ?? "collecting",
      draftVersion: 1,
      plan: plan as Prisma.InputJsonValue,
      slots: slots as Prisma.InputJsonValue,
      title: input.title ?? plan.title,
      summary: input.summary ?? plan.summary,
      messageId: input.messageId,
    },
  });
}

/** Upsert the compiled A2UI document for a surface; returns documentRef for MessageBlock. */
export async function upsertInteractionSurface(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: UpsertInteractionSurfaceInput,
): Promise<{ surface: InteractionSurfaceRow; documentRef: string }> {
  const surface = await prisma.interactionSurface.upsert({
    where: {
      interactionId_surfaceId: {
        interactionId: input.interactionId,
        surfaceId: input.surfaceId,
      },
    },
    create: {
      interactionId: input.interactionId,
      surfaceId: input.surfaceId,
      protocolFamily: input.protocolFamily,
      document: input.document as Prisma.InputJsonValue,
      draftVersion: input.draftVersion,
    },
    update: {
      protocolFamily: input.protocolFamily,
      document: input.document as Prisma.InputJsonValue,
      draftVersion: input.draftVersion,
    },
  });
  return {
    surface,
    documentRef: a2uiSurfaceDocumentRef({
      interactionId: input.interactionId,
      surfaceId: input.surfaceId,
    }),
  };
}

export async function getInteraction(
  prisma: PrismaClient | Prisma.TransactionClient,
  interactionId: string,
): Promise<InteractionRow | null> {
  return prisma.interaction.findUnique({ where: { id: interactionId } });
}

export async function getInteractionSurface(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { interactionId: string; surfaceId: string },
): Promise<InteractionSurfaceRow | null> {
  return prisma.interactionSurface.findUnique({
    where: {
      interactionId_surfaceId: {
        interactionId: input.interactionId,
        surfaceId: input.surfaceId,
      },
    },
  });
}

/** Resolve a MessageBlock.documentRef to the stored A2UI message list. */
export async function resolveA2uiSurfaceDocument(
  prisma: PrismaClient | Prisma.TransactionClient,
  documentRef: string,
): Promise<{
  interactionId: string;
  surfaceId: string;
  document: unknown;
  draftVersion: number;
} | null> {
  const parsed = parseA2uiSurfaceDocumentRef(documentRef);
  if (!parsed) return null;
  const surface = await getInteractionSurface(prisma, parsed);
  if (!surface) return null;
  return {
    interactionId: surface.interactionId,
    surfaceId: surface.surfaceId,
    document: surface.document,
    draftVersion: surface.draftVersion,
  };
}

export async function listThreadInteractions(
  prisma: PrismaClient | Prisma.TransactionClient,
  threadId: string,
): Promise<InteractionRow[]> {
  return prisma.interaction.findMany({
    where: { threadId },
    orderBy: { updatedAt: "desc" },
  });
}

export type PatchInteractionSlotsInput = {
  interactionId: string;
  /** Reject when the client's expected version does not match. */
  expectedDraftVersion: number;
  slots: Record<string, unknown>;
  /** When true (default), clear confirmedVersion after a draft edit. */
  clearConfirmation?: boolean;
  status?: InteractionStatus;
};

export class InteractionVersionConflictError extends Error {
  readonly code = "INTERACTION_VERSION_CONFLICT" as const;
  constructor(
    readonly interactionId: string,
    readonly expectedDraftVersion: number,
    readonly actualDraftVersion: number,
  ) {
    super("Interaction draft version conflict");
    this.name = "InteractionVersionConflictError";
  }
}

export class InteractionNotFoundError extends Error {
  readonly code = "INTERACTION_NOT_FOUND" as const;
  constructor(readonly interactionId: string) {
    super("Interaction not found");
    this.name = "InteractionNotFoundError";
  }
}

/**
 * The row reached a status no write may touch before this write landed.
 *
 * A card can be superseded between the moment a client lists it and the moment
 * the person's edit arrives. That is a lost race, not a server fault, so it
 * carries its own type for the route to answer as a conflict.
 */
export class InteractionTerminalError extends Error {
  readonly code = "INTERACTION_TERMINAL" as const;
  constructor(
    readonly interactionId: string,
    readonly status: string,
  ) {
    super(`Interaction is ${status} and cannot be edited`);
    this.name = "InteractionTerminalError";
  }
}

/**
 * Apply slot edits under optimistic concurrency on draftVersion.
 * Increments draftVersion and clears confirmedVersion (unless opted out).
 */
export async function patchInteractionSlots(
  prisma: PrismaClient,
  input: PatchInteractionSlotsInput,
): Promise<InteractionRow> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const current = await tx.interaction.findUnique({ where: { id: input.interactionId } });
      if (!current) throw new InteractionNotFoundError(input.interactionId);
      if (current.draftVersion !== input.expectedDraftVersion) {
        throw new InteractionVersionConflictError(
          input.interactionId,
          input.expectedDraftVersion,
          current.draftVersion,
        );
      }
      const nextSlots = { ...asSlots(current.slots), ...input.slots };
      const clearConfirmation = input.clearConfirmation !== false;
      return tx.interaction.update({
        where: { id: input.interactionId },
        data: {
          slots: nextSlots as Prisma.InputJsonValue,
          draftVersion: { increment: 1 },
          ...(clearConfirmation ? { confirmedVersion: null } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
    }),
  );
}

export type ConfirmInteractionInput = {
  interactionId: string;
  draftVersion: number;
  approvalEffectId?: string;
  status?: InteractionStatus;
};

export class InteractionUnconfirmedDraftError extends Error {
  readonly code = "INTERACTION_DRAFT_STALE" as const;
  constructor(
    readonly interactionId: string,
    readonly draftVersion: number,
    readonly actualDraftVersion: number,
  ) {
    super("Interaction draft is not the confirmed version");
    this.name = "InteractionUnconfirmedDraftError";
  }
}

/** Bind confirmedVersion = draftVersion when the client confirms the current draft. */
export async function confirmInteractionDraft(
  prisma: PrismaClient,
  input: ConfirmInteractionInput,
): Promise<InteractionRow> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const current = await tx.interaction.findUnique({ where: { id: input.interactionId } });
      if (!current) throw new InteractionNotFoundError(input.interactionId);
      if (current.draftVersion !== input.draftVersion) {
        throw new InteractionVersionConflictError(
          input.interactionId,
          input.draftVersion,
          current.draftVersion,
        );
      }
      return tx.interaction.update({
        where: { id: input.interactionId },
        data: {
          confirmedVersion: current.draftVersion,
          status: input.status ?? "awaiting_approval",
          ...(input.approvalEffectId ? { approvalEffectId: input.approvalEffectId } : {}),
        },
      });
    }),
  );
}

/** True only when confirmedVersion matches draftVersion (send gate). */
export function interactionSendAllowed(interaction: {
  draftVersion: number;
  confirmedVersion: number | null;
}): boolean {
  return (
    interaction.confirmedVersion !== null &&
    interaction.confirmedVersion === interaction.draftVersion
  );
}
