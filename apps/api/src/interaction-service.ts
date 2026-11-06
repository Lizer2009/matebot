import type { ConnectorProvider, ManagedConnectorProvider } from "@matebot/adapter-kit";
import type {
  EmailCapabilityRow,
  InteractionEmailDelivery,
  InteractionEmailSender,
} from "@matebot/adapters";
import {
  deliverInteractionEmail,
  emailCapabilityFromRows,
  emailSendAdapterContext,
  loadEmailReconnectRefs,
  loadOwnerEmailConnections,
} from "@matebot/adapters";
import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import {
  applyInteractionFieldChange,
  canExecuteConfirmedInteraction,
  confirmedEffectMatchesDraft,
  confirmInteractionDraftState,
  emailCapabilityAllowsSend,
  emailDeliveryOutcome,
  emailSurfaceBlockFields,
  interactionConfirmEffectRequest,
  interactionConfirmIdempotencyKey,
  interactionEffectKind,
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

export type { PublishInteractionSurfaceInput } from "@matebot/adapters";
export { publishInteractionSurface } from "@matebot/adapters";

function isEmailPlan(plan: InteractionPlan): boolean {
  return plan.intent === "email.compose" || plan.intent === "email.send";
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

export type InteractionMailboxDeps = {
  userId: string;
  emailConnections?: EmailCapabilityRow[];
  reconnectRefs?: string[];
  connector?: Pick<ConnectorProvider, "execute"> & {
    listReconnectRefs?: ManagedConnectorProvider["listReconnectRefs"];
    managed?(
      id: string,
    ): { listReconnectRefs?: ManagedConnectorProvider["listReconnectRefs"] } | undefined;
  };
};

export type ConfirmInteractionServiceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  interactionId: string;
  draftVersion: number;
} & InteractionMailboxDeps;

export class InteractionEffectRunMissingError extends Error {
  readonly code = "INTERACTION_EFFECT_RUN_MISSING" as const;
  constructor(readonly interactionId: string) {
    super("Interaction has no run to bind an effect");
    this.name = "InteractionEffectRunMissingError";
  }
}

/** The mailbox rejected the confirmed draft. The effect stays failed so a later send can retry. */
export class InteractionEmailDeliveryError extends Error {
  readonly code = "INTERACTION_EMAIL_DELIVERY_FAILED" as const;
  readonly outcome: "failed" | "unknown";
  constructor(message: string, outcome: "failed" | "unknown" = "failed") {
    super(message);
    this.name = "InteractionEmailDeliveryError";
    this.outcome = outcome;
  }
}

/** Send was refused because the draft is not the confirmed version (or the run is finished). */
export class InteractionSendRejectedError extends Error {
  readonly code: "unconfirmed" | "terminal" | "needs_connection" | "unknown";
  constructor(code: "unconfirmed" | "terminal" | "needs_connection" | "unknown", message: string) {
    super(message);
    this.name = "InteractionSendRejectedError";
    this.code = code;
  }
}

async function resolveMailboxCapability(
  prisma: PrismaClient,
  input: InteractionMailboxDeps & { spaceId: string },
) {
  const connections =
    input.emailConnections ??
    (await loadOwnerEmailConnections(prisma, { spaceId: input.spaceId, userId: input.userId }));
  const reconnectRefs =
    input.reconnectRefs ??
    (await loadEmailReconnectRefs(
      input.connector?.listReconnectRefs ??
        input.connector?.managed?.("composio")?.listReconnectRefs,
      {
        operationId: "interaction.email.preflight",
        traceId: "interaction.email.preflight",
        spaceId: input.spaceId,
        userId: input.userId,
        signal: new AbortController().signal,
      },
    ));
  return emailCapabilityFromRows(connections, reconnectRefs);
}

function rejectUnlessMailboxReady(
  snapshot: ReturnType<typeof emailCapabilityFromRows>,
): asserts snapshot is ReturnType<typeof emailCapabilityFromRows> & {
  status: "CONNECTED_AND_READY";
} {
  if (emailCapabilityAllowsSend(snapshot.status)) return;
  throw new InteractionSendRejectedError(
    "needs_connection",
    snapshot.status === "REQUIRES_REAUTH"
      ? "Reconnect the mailbox before sending"
      : "Connect a mailbox before sending",
  );
}

function interactionSlots(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

async function resolveEffectRunId(
  prisma: PrismaClient,
  interaction: { id: string; runId: string | null },
  threadId: string,
  spaceId: string,
): Promise<string> {
  if (interaction.runId) return interaction.runId;
  const run = await prisma.run.findFirst({
    where: { threadId, spaceId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!run) throw new InteractionEffectRunMissingError(interaction.id);
  return run.id;
}

export async function confirmInteractionService(
  prisma: PrismaClient,
  input: ConfirmInteractionServiceInput,
): Promise<{ confirmedVersion: number; effectId: string; idempotencyKey: string }> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current || current.threadId !== input.threadId) {
    throw new InteractionNotFoundError(input.interactionId);
  }
  rejectUnlessMailboxReady(await resolveMailboxCapability(prisma, input));
  const plan = current.plan as InteractionPlan;
  const slots = interactionSlots(current.slots);
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

  const runId = await resolveEffectRunId(prisma, current, input.threadId, input.spaceId);
  const idempotencyKey = interactionConfirmIdempotencyKey(
    input.interactionId,
    confirmed.confirmedVersion,
  );
  const request = interactionConfirmEffectRequest({
    interactionId: input.interactionId,
    intent: plan.intent,
    draftVersion: current.draftVersion,
    confirmedVersion: confirmed.confirmedVersion,
    slots,
  });
  const kind = interactionEffectKind(plan.intent);

  const effectId = await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.externalEffect.findUnique({ where: { idempotencyKey } });
      const effect =
        existing ??
        (await tx.externalEffect.create({
          data: {
            spaceId: input.spaceId,
            runId,
            kind,
            idempotencyKey,
            status: "intended",
            request: request as Prisma.InputJsonValue,
            reviewDecision: "allow",
            reviewReason: "user confirmed draft",
          },
        }));
      if (effect.spaceId !== input.spaceId || effect.runId !== runId) {
        throw new Error("Stored effect does not belong to this interaction");
      }
      const approvalEffectId = effect.id;
      const updated = await tx.interaction.updateMany({
        where: { id: input.interactionId, draftVersion: input.draftVersion },
        data: {
          confirmedVersion: confirmed.confirmedVersion,
          status: confirmed.status,
          approvalEffectId,
        },
      });
      if (updated.count !== 1) {
        throw new InteractionVersionConflictError(
          input.interactionId,
          input.draftVersion,
          current.draftVersion,
        );
      }
      await projectEmailSurface(tx, {
        interaction: current,
        plan,
        confirmedVersion: confirmed.confirmedVersion,
        draftVersion: current.draftVersion,
        runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        interactionStatus: confirmed.status,
        approvalEffectId,
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.interaction.approval_requested",
        runId,
        payload: {
          interactionId: input.interactionId,
          draftVersion: current.draftVersion,
          confirmedVersion: confirmed.confirmedVersion,
          approvalEffectId,
          messageId: current.messageId ?? undefined,
        },
      });
      return approvalEffectId;
    }),
  );

  return { confirmedVersion: confirmed.confirmedVersion, effectId, idempotencyKey };
}

async function projectEmailSurface(
  tx: Prisma.TransactionClient,
  input: {
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
  },
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

export type ExecuteConfirmedInteractionResult = {
  effectId: string;
  idempotencyKey: string;
  duplicate: boolean;
  executed: boolean;
  providerMessageId?: string;
};

function emailSlots(request: unknown): { to: string; subject: string; body: string } {
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

async function finishEmailSend(
  prisma: PrismaClient,
  input: {
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
  },
): Promise<void> {
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
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.externalEffect.updateMany({
        where: { id: input.effectId },
        data: {
          status: input.effectStatus,
          result: input.result as Prisma.InputJsonValue,
        },
      });
      await tx.interaction.updateMany({
        where: { id: input.interaction.id, draftVersion: input.draftVersion },
        data: { status: input.interactionStatus },
      });
      await projectEmailSurface(tx, {
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
    }),
  );
}

/**
 * Gate for send. Rejects when confirmedVersion is missing or stale.
 * `email.send` delivers through the actor's bound mailbox connection.
 * In-flight (`executing`) and UNKNOWN do not resend; E′ reconciles `ambiguous`.
 */
export async function executeConfirmedInteractionService(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    interactionId: string;
  } & InteractionMailboxDeps,
): Promise<ExecuteConfirmedInteractionResult> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current || current.threadId !== input.threadId || current.spaceId !== input.spaceId) {
    throw new InteractionNotFoundError(input.interactionId);
  }
  if (
    current.confirmedVersion === null ||
    current.confirmedVersion !== current.draftVersion ||
    !current.approvalEffectId
  ) {
    throw new InteractionSendRejectedError(
      "unconfirmed",
      "Send requires confirmedVersion to equal draftVersion",
    );
  }
  const confirmedVersion = current.confirmedVersion;
  const effect = await prisma.externalEffect.findUnique({
    where: { id: current.approvalEffectId },
  });
  if (!effect || effect.spaceId !== input.spaceId) {
    throw new InteractionSendRejectedError("unconfirmed", "Send requires a confirmed effect");
  }
  const request =
    effect.request && typeof effect.request === "object" && !Array.isArray(effect.request)
      ? (effect.request as { draftVersion?: unknown; confirmedVersion?: unknown })
      : {};
  if (
    !confirmedEffectMatchesDraft(request, {
      draftVersion: current.draftVersion,
      confirmedVersion,
    })
  ) {
    throw new InteractionSendRejectedError(
      "unconfirmed",
      "Send requires confirmedVersion to equal draftVersion",
    );
  }
  if (effect.status === "completed" || effect.status === "reconciled") {
    return {
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      duplicate: true,
      executed: true,
    };
  }
  const gate = canExecuteConfirmedInteraction({
    draftVersion: current.draftVersion,
    confirmedVersion,
    status: current.status as InteractionLifecycleStatus,
  });
  if (!gate.ok) {
    throw new InteractionSendRejectedError(gate.error, gate.message);
  }
  if (effect.kind !== "email.send") {
    return {
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      duplicate: false,
      executed: false,
    };
  }

  const mailbox = await resolveMailboxCapability(prisma, input);
  rejectUnlessMailboxReady(mailbox);
  const connection = mailbox.connection;
  if (!connection || !input.connector) {
    throw new InteractionSendRejectedError("needs_connection", "Connect a mailbox before sending");
  }

  const reconciling = effect.status === "ambiguous";
  const claimed = await prisma.externalEffect.updateMany({
    where: { id: effect.id, status: effect.status },
    data: { status: "ambiguous" },
  });
  if (claimed.count !== 1) {
    const latest = await prisma.externalEffect.findUnique({ where: { id: effect.id } });
    if (latest && (latest.status === "completed" || latest.status === "reconciled")) {
      return {
        effectId: latest.id,
        idempotencyKey: latest.idempotencyKey,
        duplicate: true,
        executed: true,
      };
    }
    throw new InteractionSendRejectedError("unconfirmed", "Send is already in progress");
  }

  await prisma.interaction.updateMany({
    where: { id: current.id, draftVersion: current.draftVersion },
    data: { status: "executing" },
  });

  const plan = current.plan as InteractionPlan;
  const interaction = {
    id: current.id,
    messageId: current.messageId,
    title: current.title,
    summary: current.summary,
  };
  const finish = (args: {
    effectStatus: "completed" | "reconciled" | "failed" | "ambiguous";
    interactionStatus: "succeeded" | "failed" | "unknown";
    result: Record<string, unknown>;
  }) =>
    finishEmailSend(prisma, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      interaction,
      plan,
      draftVersion: current.draftVersion,
      confirmedVersion,
      effectId: effect.id,
      runId: effect.runId,
      ...args,
    });

  try {
    await withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        await projectEmailSurface(tx, {
          interaction,
          plan,
          confirmedVersion,
          draftVersion: current.draftVersion,
          runId: effect.runId,
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          interactionStatus: "executing",
          effectStatus: "ambiguous",
          approvalEffectId: effect.id,
          actionEvent: "thread.interaction.action_started",
          progress: "executing",
        });
        await appendEventInTransaction(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: "thread.interaction.action_progress",
          runId: effect.runId,
          payload: {
            interactionId: current.id,
            draftVersion: current.draftVersion,
            confirmedVersion,
            progress: "executing",
            template: "action-progress-card",
            lifecycle: "executing",
            messageId: current.messageId ?? undefined,
          },
        });
      }),
    );

    const draft = emailSlots(effect.request);
    const sender: InteractionEmailSender = {
      kind: "connector",
      context: emailSendAdapterContext(
        { spaceId: input.spaceId, userId: input.userId },
        connection,
      ),
      connector: input.connector,
      connectionId: connection.id,
    };

    let delivery: InteractionEmailDelivery;
    try {
      delivery = await deliverInteractionEmail(
        {
          ...draft,
          idempotencyKey: effect.idempotencyKey,
        },
        sender,
      );
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : "Could not send the email";
      const outcome = emailDeliveryOutcome({ error: message });
      await finish({
        effectStatus: outcome === "unknown" ? "ambiguous" : "failed",
        interactionStatus: outcome,
        result: { error: message },
      });
      throw new InteractionEmailDeliveryError("Could not send the email", outcome);
    }
    if (!delivery.ok) {
      const outcome = emailDeliveryOutcome(delivery);
      await finish({
        effectStatus: outcome === "unknown" ? "ambiguous" : "failed",
        interactionStatus: outcome,
        result: { error: delivery.error },
      });
      throw new InteractionEmailDeliveryError(delivery.error, outcome);
    }

    await finish({
      effectStatus: reconciling ? "reconciled" : "completed",
      interactionStatus: "succeeded",
      result: { deliveryId: delivery.deliveryId, providerMessageId: delivery.deliveryId },
    });
    return {
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      duplicate: false,
      executed: true,
      providerMessageId: delivery.deliveryId,
    };
  } catch (error) {
    if (
      error instanceof InteractionEmailDeliveryError ||
      error instanceof InteractionSendRejectedError
    ) {
      throw error;
    }
    try {
      await finish({
        effectStatus: "failed",
        interactionStatus: "failed",
        result: { error: "Could not send the email" },
      });
    } catch {
      // Keep the original failure; finishing is best-effort.
    }
    throw new InteractionEmailDeliveryError("Could not send the email");
  }
}
