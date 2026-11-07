import type {
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
} from "@matebot/adapter-kit";
import type {
  EmailCapabilityRow,
  InteractionCalendarSender,
  InteractionEmailDelivery,
  InteractionEmailSender,
} from "@matebot/adapters";
import {
  createCalendarEvent,
  deliverInteractionEmail,
  emailCapabilityFromRows,
  emailDraftSlots,
  emailSendAdapterContext,
  enqueueEmailReconcile,
  finishInteractionEmailSend,
  interactionCapabilityFromRows,
  loadEmailReconnectRefs,
  loadOwnerEmailConnections,
  loadProviderReadiness,
  projectInteractionEmailSurface,
  reconcileAmbiguousEmailEffect,
} from "@matebot/adapters";
import type { A2uiProtocolFamily, InteractionPlan, MessageBlock } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import {
  applyInteractionFieldChange,
  canExecuteConfirmedInteraction,
  confirmedEffectMatchesDraft,
  confirmInteractionDraftState,
  deliveryNeedsReconnect,
  emailCapabilityAllowsSend,
  emailDeliveryOutcome,
  emailSurfaceBlockFields,
  interactionConfirmEffectRequest,
  interactionConfirmIdempotencyKey,
  interactionEffectKind,
  interactionRequiredApp,
  normalizeCalendarFields,
  validateCalendarEvent,
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

// The write path lives in @matebot/adapters so the model's edit tool and the
// card's own controls share one implementation. Re-exported here because the
// route and its tests import it from this module.
export {
  type UpdateInteractionFieldServiceInput,
  updateInteractionFieldService,
} from "@matebot/adapters";

export type InteractionMailboxDeps = {
  userId: string;
  emailConnections?: EmailCapabilityRow[];
  reconnectRefs?: string[];
  /** Provider health per slug; the connector's own view wins over a stale local row. */
  providerReady?: Record<string, boolean>;
  jobs?: Pick<JobPublisher, "enqueue">;
  connector?: Pick<ConnectorProvider, "execute"> & {
    listReconnectRefs?: ManagedConnectorProvider["listReconnectRefs"];
    connectionReady?: ManagedConnectorProvider["connectionReady"];
    managed?(id: string):
      | {
          listReconnectRefs?: ManagedConnectorProvider["listReconnectRefs"];
          connectionReady?: ManagedConnectorProvider["connectionReady"];
        }
      | undefined;
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
  input: InteractionMailboxDeps & { spaceId: string; intent?: string },
) {
  const connections =
    input.emailConnections ??
    (await loadOwnerEmailConnections(prisma, { spaceId: input.spaceId, userId: input.userId }));
  const managed = input.connector?.managed?.("composio") ?? input.connector;
  const context = {
    operationId: "interaction.email.preflight",
    traceId: "interaction.email.preflight",
    spaceId: input.spaceId,
    userId: input.userId,
    signal: new AbortController().signal,
  };
  const reconnectRefs =
    input.reconnectRefs ??
    (await loadEmailReconnectRefs(
      input.connector?.listReconnectRefs ?? managed?.listReconnectRefs,
      context,
    ));
  const providerReady =
    input.providerReady ??
    (await loadProviderReadiness(
      input.connector?.connectionReady ? input.connector : managed,
      context,
      connections,
    ));
  return emailCapabilityFromRows(connections, reconnectRefs, providerReady);
}

/**
 * The connection a capability acts through.
 *
 * Email uses the mailbox preflight it always did; calendar uses the calendar
 * three-state. Keeping one entry point means the execute path does not grow a
 * branch per domain, and an unregistered intent resolves to nothing rather than
 * borrowing a mailbox.
 */
async function resolveCapabilityConnection(
  prisma: PrismaClient,
  input: InteractionMailboxDeps & { spaceId: string; threadId?: string; botId?: string },
  intent: string,
  connector: InteractionMailboxDeps["connector"],
  interactionId?: string,
): Promise<{
  connection: EmailCapabilityRow | undefined;
  surfaceCapability: EmailSurfaceCapability;
}> {
  const app = interactionRequiredApp(intent);
  if (app === "calendar") {
    const connections =
      input.emailConnections ??
      (await loadOwnerEmailConnections(prisma, { spaceId: input.spaceId, userId: input.userId }));
    const managed = connector?.managed?.("composio") ?? connector;
    const context = {
      operationId: "interaction.calendar.preflight",
      traceId: "interaction.calendar.preflight",
      spaceId: input.spaceId,
      userId: input.userId,
      signal: new AbortController().signal,
    };
    const reconnectRefs =
      input.reconnectRefs ??
      (await loadEmailReconnectRefs(
        connector?.listReconnectRefs ?? managed?.listReconnectRefs,
        context,
      ));
    const providerReady =
      input.providerReady ??
      (await loadProviderReadiness(
        connector?.connectionReady ? connector : managed,
        context,
        connections,
      ));
    const snapshot = interactionCapabilityFromRows(
      intent,
      connections,
      reconnectRefs,
      providerReady,
    );
    // A calendar that is not usable refreshes the same card into its
    // connection/reconnect template, exactly as the mailbox path does, so the
    // user is never left with a dead end. Then the send is refused.
    if (!emailCapabilityAllowsSend(snapshot.status)) {
      if (interactionId && input.threadId && input.botId) {
        await projectCapabilityGate(
          prisma,
          {
            spaceId: input.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            interactionId,
          },
          snapshot.surfaceCapability,
        ).catch(() => undefined);
      }
      throw new InteractionSendRejectedError(
        "needs_connection",
        snapshot.status === "REQUIRES_REAUTH"
          ? "Reconnect the calendar before creating an event"
          : "Connect a calendar before creating an event",
      );
    }
    return {
      connection: snapshot.connection,
      surfaceCapability: snapshot.surfaceCapability,
    };
  }
  const mailbox = await resolveMailboxCapability(prisma, input);
  if (emailCapabilityAllowsSend(mailbox.status)) {
    return { connection: mailbox.connection, surfaceCapability: mailbox.surfaceCapability };
  }
  if (interactionId && input.threadId && input.botId) {
    await projectMailboxGate(
      prisma,
      {
        spaceId: input.spaceId,
        threadId: input.threadId ?? "",
        botId: input.botId ?? "",
        interactionId,
      },
      mailbox,
    ).catch(() => undefined);
  }
  rejectUnlessMailboxReady(mailbox);
  return { connection: mailbox.connection, surfaceCapability: mailbox.surfaceCapability };
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

/**
 * A preflight miss must land on the card, not in prose: refresh the same surface
 * into its connection/reconnect template so the user has a button to press.
 */
async function projectCapabilityGate(
  prisma: PrismaClient,
  target: { spaceId: string; threadId: string; botId: string; interactionId: string },
  capability: EmailSurfaceCapability,
): Promise<void> {
  const current = await getInteraction(prisma, target.interactionId);
  if (!current) return;
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.interaction.updateMany({
        where: { id: current.id, draftVersion: current.draftVersion },
        data: { status: "needs_connection" },
      });
      await projectInteractionEmailSurface(tx, {
        interaction: {
          id: current.id,
          messageId: current.messageId,
          title: current.title,
          summary: current.summary,
        },
        plan: current.plan as InteractionPlan,
        confirmedVersion: current.confirmedVersion,
        draftVersion: current.draftVersion,
        runId: current.runId ?? undefined,
        spaceId: target.spaceId,
        threadId: target.threadId,
        botId: target.botId,
        interactionStatus: "needs_connection",
        capability,
      });
    }),
  );
}

async function projectMailboxGate(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; botId: string; interactionId: string },
  snapshot: ReturnType<typeof emailCapabilityFromRows>,
): Promise<void> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current) return;
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.interaction.updateMany({
        where: { id: current.id, draftVersion: current.draftVersion },
        data: { status: "needs_connection" },
      });
      await projectInteractionEmailSurface(tx, {
        interaction: {
          id: current.id,
          messageId: current.messageId,
          title: current.title,
          summary: current.summary,
        },
        plan: current.plan as InteractionPlan,
        confirmedVersion: current.confirmedVersion,
        draftVersion: current.draftVersion,
        runId: current.runId ?? undefined,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        interactionStatus: "needs_connection",
        capability: snapshot.surfaceCapability,
      });
    }),
  );
}

/** Gate Send on a usable mailbox, and refresh the card when it is not usable. */
async function requireReadyMailbox(
  prisma: PrismaClient,
  input: InteractionMailboxDeps & { spaceId: string; threadId: string; botId: string },
  interactionId: string,
): Promise<ReturnType<typeof emailCapabilityFromRows>> {
  const snapshot: ReturnType<typeof emailCapabilityFromRows> = await resolveMailboxCapability(
    prisma,
    input,
  );
  if (emailCapabilityAllowsSend(snapshot.status)) return snapshot;
  await projectMailboxGate(prisma, { ...input, interactionId }, snapshot).catch(() => undefined);
  rejectUnlessMailboxReady(snapshot);
  return snapshot;
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
  await requireReadyMailbox(prisma, input, current.id);
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
      await projectInteractionEmailSurface(tx, {
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

export type ExecuteConfirmedInteractionResult = {
  effectId: string;
  idempotencyKey: string;
  duplicate: boolean;
  executed: boolean;
  providerMessageId?: string;
};

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
  const confirmedVersion = current.confirmedVersion;
  if (
    confirmedVersion === null ||
    confirmedVersion !== current.draftVersion ||
    !current.approvalEffectId
  ) {
    throw new InteractionSendRejectedError(
      "unconfirmed",
      "Send requires confirmedVersion to equal draftVersion",
    );
  }
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
  if (effect.status === "ambiguous") {
    throw new InteractionSendRejectedError("unknown", "Send result is unknown; do not send again");
  }
  // Which capability does this effect belong to? Calendar create runs the same
  // claim/finish lifecycle as email, with its own sender and its own connection.
  const isCalendar = effect.kind === "calendar.create";
  if (effect.kind !== "email.send" && !isCalendar) {
    return {
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      duplicate: false,
      executed: false,
    };
  }

  const mailbox = await resolveCapabilityConnection(
    prisma,
    input,
    current.intent,
    input.connector,
    current.id,
  );
  const connection = mailbox.connection;
  if (!connection || !input.connector) {
    throw new InteractionSendRejectedError(
      "needs_connection",
      isCalendar
        ? "Connect a calendar before creating an event"
        : "Connect a mailbox before sending",
    );
  }

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
    capability?: EmailSurfaceCapability;
  }) =>
    finishInteractionEmailSend(prisma, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      interaction,
      plan,
      draftVersion: current.draftVersion,
      confirmedVersion,
      effectId: effect.id,
      runId: effect.runId,
      expectedEffectStatus: "ambiguous",
      ...args,
    });
  const scheduleReconcile = async () => {
    try {
      await enqueueEmailReconcile(input.jobs, effect.id);
    } catch {
      // Job-reconciler recovers UNKNOWN rows if enqueue fails.
    }
  };

  try {
    await withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        await projectInteractionEmailSurface(tx, {
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

    if (isCalendar) {
      // Calendar: validate the confirmed slots, then create through the user's
      // own connection. A failure is classified exactly as an email failure is,
      // so UNKNOWN reconciliation and no-auto-retry behave identically.
      const slots = interactionSlots(
        effect.request && (effect.request as { slots?: unknown }).slots,
      );
      const normalized = normalizeCalendarFields(slots);
      const validated = validateCalendarEvent(normalized);
      if (!validated.ok) {
        await finish({
          effectStatus: "failed",
          interactionStatus: "failed",
          result: { error: validated.error },
        });
        throw new InteractionEmailDeliveryError(
          `Calendar event rejected: ${validated.error}`,
          "failed",
        );
      }
      const calendarSender: InteractionCalendarSender = {
        kind: "connector",
        context: emailSendAdapterContext(
          { spaceId: input.spaceId, userId: input.userId },
          connection,
        ),
        connector: input.connector,
        connectionId: connection.id,
      };
      let created: Awaited<ReturnType<typeof createCalendarEvent>>;
      try {
        created = await createCalendarEvent(
          { event: validated.event, idempotencyKey: effect.idempotencyKey },
          calendarSender,
        );
      } catch (error) {
        const message =
          error instanceof Error && error.message ? error.message : "Could not create the event";
        const outcome = emailDeliveryOutcome({ error: message });
        await finish({
          effectStatus: outcome === "unknown" ? "ambiguous" : "failed",
          interactionStatus: outcome,
          result: { error: message },
        });
        if (outcome === "unknown") await scheduleReconcile();
        throw new InteractionEmailDeliveryError("Could not create the event", outcome);
      }
      if (!created.ok) {
        const outcome = emailDeliveryOutcome(created);
        await finish({
          effectStatus: outcome === "unknown" ? "ambiguous" : "failed",
          interactionStatus: outcome,
          result: { error: created.error },
        });
        if (outcome === "unknown") await scheduleReconcile();
        throw new InteractionEmailDeliveryError(created.error, outcome);
      }
      await finish({
        effectStatus: "completed",
        interactionStatus: "succeeded",
        result: { providerMessageId: created.eventId, deliveryId: created.eventId },
      });
      return {
        effectId: effect.id,
        idempotencyKey: effect.idempotencyKey,
        duplicate: false,
        executed: true,
        providerMessageId: created.eventId,
      };
    }

    const draft = emailDraftSlots(effect.request);
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
        // A dead authorization keeps the same card actionable as reconnect.
        ...(deliveryNeedsReconnect(message) ? { capability: "requires_reauth" as const } : {}),
      });
      if (outcome === "unknown") await scheduleReconcile();
      throw new InteractionEmailDeliveryError("Could not send the email", outcome);
    }
    if (!delivery.ok) {
      const outcome = emailDeliveryOutcome(delivery);
      await finish({
        effectStatus: outcome === "unknown" ? "ambiguous" : "failed",
        interactionStatus: outcome,
        result: { error: delivery.error },
        ...(deliveryNeedsReconnect(delivery.error)
          ? { capability: "requires_reauth" as const }
          : {}),
      });
      if (outcome === "unknown") await scheduleReconcile();
      throw new InteractionEmailDeliveryError(delivery.error, outcome);
    }

    await finish({
      effectStatus: "completed",
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

export type ReconcileConfirmedInteractionResult = {
  effectId: string;
  status: "succeeded" | "failed" | "unknown";
  providerMessageId?: string;
};

/**
 * Check status: inspect provider evidence for an UNKNOWN send. Never sends.
 */
export async function reconcileConfirmedInteractionService(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    interactionId: string;
  } & InteractionMailboxDeps,
): Promise<ReconcileConfirmedInteractionResult> {
  const current = await getInteraction(prisma, input.interactionId);
  if (!current || current.threadId !== input.threadId || current.spaceId !== input.spaceId) {
    throw new InteractionNotFoundError(input.interactionId);
  }
  if (current.status !== "unknown" || !current.approvalEffectId) {
    throw new InteractionSendRejectedError(
      current.status === "unknown" ? "unknown" : "unconfirmed",
      "Send result is unknown; do not send again",
    );
  }
  const outcome = await reconcileAmbiguousEmailEffect(
    { prisma, jobs: input.jobs, connector: input.connector },
    { effectId: current.approvalEffectId },
  );
  if (outcome.status === "ignored") {
    const latest = await getInteraction(prisma, input.interactionId);
    if (latest?.status === "succeeded") {
      return { effectId: current.approvalEffectId, status: "succeeded" };
    }
    if (latest?.status === "failed") {
      return { effectId: current.approvalEffectId, status: "failed" };
    }
    return { effectId: current.approvalEffectId, status: "unknown" };
  }
  return {
    effectId: current.approvalEffectId,
    status: outcome.status,
    ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
  };
}
