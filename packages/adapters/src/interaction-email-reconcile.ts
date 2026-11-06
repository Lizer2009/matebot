import type {
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
} from "@matebot/adapter-kit";
import { actionReconcileJob } from "@matebot/adapter-kit";
import type { InteractionPlan } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { getLogger } from "@matebot/logging";
import { inspectInteractionEmailDelivery } from "./interaction-email.js";
import {
  emailCapabilityFromRows,
  emailSendAdapterContext,
  loadEmailReconnectRefs,
  loadOwnerEmailConnections,
} from "./interaction-email-capability.js";
import { emailDraftSlots, finishInteractionEmailSend } from "./interaction-email-outcome.js";

export const EMAIL_RECONCILE_POLL_MS = 15_000;
export const EMAIL_RECONCILE_DEADLINE_MS = 2 * 60_000;

export type EmailReconcileDeps = {
  prisma: PrismaClient;
  jobs?: Pick<JobPublisher, "enqueue">;
  connector?: Pick<ConnectorProvider, "execute"> & {
    listReconnectRefs?: ManagedConnectorProvider["listReconnectRefs"];
    managed?(
      id: string,
    ): { listReconnectRefs?: ManagedConnectorProvider["listReconnectRefs"] } | undefined;
  };
};

export async function enqueueEmailReconcile(
  jobs: Pick<JobPublisher, "enqueue"> | undefined,
  effectId: string,
  availableAt?: Date,
): Promise<void> {
  if (!jobs) return;
  await jobs.enqueue(actionReconcileJob(effectId, availableAt));
}

export type ReconcileAmbiguousEmailResult = {
  status: "succeeded" | "failed" | "unknown" | "ignored";
  providerMessageId?: string;
};

/**
 * Inspect SENT evidence for one UNKNOWN email.send. Never calls send.
 * In-flight claims (`executing` + `ambiguous`) are ignored so a live Send is not raced.
 */
export async function reconcileAmbiguousEmailEffect(
  deps: EmailReconcileDeps,
  payload: { effectId: string },
): Promise<ReconcileAmbiguousEmailResult> {
  const effect = await deps.prisma.externalEffect.findUnique({
    where: { id: payload.effectId },
    include: {
      run: { select: { spaceId: true, userId: true, botId: true, threadId: true } },
    },
  });
  if (effect?.kind !== "email.send" || effect.status !== "ambiguous") {
    return { status: "ignored" };
  }
  const interaction = await deps.prisma.interaction.findFirst({
    where: { approvalEffectId: effect.id },
  });
  if (interaction?.status !== "unknown" || !interaction.confirmedVersion) {
    return { status: "ignored" };
  }
  if (!deps.connector) {
    await enqueueEmailReconcile(
      deps.jobs,
      effect.id,
      new Date(Date.now() + EMAIL_RECONCILE_POLL_MS),
    );
    return { status: "unknown" };
  }

  const owner = { spaceId: effect.run.spaceId, userId: effect.run.userId };
  const connections = await loadOwnerEmailConnections(deps.prisma, owner);
  const reconnectRefs = await loadEmailReconnectRefs(
    deps.connector.listReconnectRefs ?? deps.connector.managed?.("composio")?.listReconnectRefs,
    {
      operationId: `action.reconcile:${effect.id}`,
      traceId: `action.reconcile:${effect.id}`,
      spaceId: owner.spaceId,
      userId: owner.userId,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const mailbox = emailCapabilityFromRows(connections, reconnectRefs);
  const connection = mailbox.connection;
  if (!connection) {
    await enqueueEmailReconcile(
      deps.jobs,
      effect.id,
      new Date(Date.now() + EMAIL_RECONCILE_POLL_MS),
    );
    return { status: "unknown" };
  }

  const draft = {
    ...emailDraftSlots(effect.request),
    idempotencyKey: effect.idempotencyKey,
  };
  let inspect: Awaited<ReturnType<typeof inspectInteractionEmailDelivery>>;
  try {
    inspect = await inspectInteractionEmailDelivery(draft, {
      kind: "connector",
      context: emailSendAdapterContext(
        { spaceId: effect.run.spaceId, userId: effect.run.userId },
        connection,
      ),
      connector: deps.connector,
      connectionId: connection.id,
    });
  } catch (error) {
    getLogger().warn("email reconcile inspect deferred", { error });
    await enqueueEmailReconcile(
      deps.jobs,
      effect.id,
      new Date(Date.now() + EMAIL_RECONCILE_POLL_MS),
    );
    return { status: "unknown" };
  }

  const plan = interaction.plan as InteractionPlan;
  const finishBase = {
    spaceId: interaction.spaceId,
    threadId: interaction.threadId,
    botId: effect.run.botId,
    interaction: {
      id: interaction.id,
      messageId: interaction.messageId,
      title: interaction.title,
      summary: interaction.summary,
    },
    plan,
    draftVersion: interaction.draftVersion,
    confirmedVersion: interaction.confirmedVersion,
    effectId: effect.id,
    runId: effect.runId,
    expectedEffectStatus: "ambiguous",
  };

  if (inspect.found) {
    const applied = await finishInteractionEmailSend(deps.prisma, {
      ...finishBase,
      effectStatus: "reconciled",
      interactionStatus: "succeeded",
      result: { deliveryId: inspect.deliveryId, providerMessageId: inspect.deliveryId },
    });
    return applied
      ? { status: "succeeded", providerMessageId: inspect.deliveryId }
      : { status: "ignored" };
  }

  if ("outcome" in inspect && inspect.outcome === "unknown") {
    await enqueueEmailReconcile(
      deps.jobs,
      effect.id,
      new Date(Date.now() + EMAIL_RECONCILE_POLL_MS),
    );
    return { status: "unknown" };
  }

  if (Date.now() - effect.updatedAt.getTime() < EMAIL_RECONCILE_DEADLINE_MS) {
    await enqueueEmailReconcile(
      deps.jobs,
      effect.id,
      new Date(Date.now() + EMAIL_RECONCILE_POLL_MS),
    );
    return { status: "unknown" };
  }

  const applied = await finishInteractionEmailSend(deps.prisma, {
    ...finishBase,
    effectStatus: "failed",
    interactionStatus: "failed",
    result: { error: "Could not confirm whether the email was sent" },
  });
  return applied ? { status: "failed" } : { status: "ignored" };
}

/** Re-enqueue UNKNOWN email.send rows whose Graphile job was lost. Skip in-flight sends. */
export async function reconcileAmbiguousEmailEffects(deps: EmailReconcileDeps): Promise<void> {
  const rows = await deps.prisma.interaction.findMany({
    where: { status: "unknown", approvalEffectId: { not: null } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { approvalEffectId: true },
  });
  for (const row of rows) {
    if (row.approvalEffectId) await enqueueEmailReconcile(deps.jobs, row.approvalEffectId);
  }
}
