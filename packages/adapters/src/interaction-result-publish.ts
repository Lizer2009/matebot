import type { InteractionPlan, MessageBlock, ResultSurface } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef, ResultSurfaceSchema } from "@matebot/contracts";
import { interactionCardKey } from "@matebot/core/node/interaction-card-key";
import type { PrismaClient } from "@matebot/db";
import { getLogger } from "@matebot/logging";
import { senderStampFromBlock } from "./interaction-publish.js";

/**
 * Publishing a result surface.
 *
 * This is the read-side twin of the draft publish: it writes an Interaction, its
 * Surface document, one `a2ui_surface` message block and the SSE events, so the
 * card the user sees comes from the server's own rows. It has no effect writer by
 * construction — a result cannot send, create, or mutate anything.
 */

export type ResultPublishDeps = {
  prisma: PrismaClient;
  appendEvent: (tx: unknown, input: Record<string, unknown>) => Promise<{ seq: number }>;
  notify: (threadId: string, seq: number) => Promise<void>;
};

export type PublishResultSurfaceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId?: string;
  /** The registered capability intent, e.g. `interaction.result`. */
  intent: string;
  surface: ResultSurface;
  surfaceId: string;
  title?: string;
};

export type PublishResultSurfaceResult =
  | { ok: true; interactionId: string; surfaceId: string; messageId: string; eventSeq: number }
  | { ok: false; error: string };

/** A plan the interaction row can store; a result carries no fields or action. */
function resultPlan(input: { intent: string; surface: ResultSurface }): InteractionPlan {
  return {
    intent: input.intent,
    title: input.surface.title,
    summary: input.surface.provenance.source,
    fields: [],
    nextStep: "complete",
    riskLevel: "low",
  };
}

export async function publishResultSurface(
  deps: ResultPublishDeps,
  input: PublishResultSurfaceInput,
): Promise<PublishResultSurfaceResult> {
  const parsed = ResultSurfaceSchema.safeParse(input.surface);
  if (!parsed.success) return { ok: false, error: "invalid_result_surface" };
  const surface = parsed.data;
  const surfaceId = input.surfaceId.trim();
  if (!surfaceId) return { ok: false, error: "surfaceId is required" };

  // The compiler only needs the surface; the plan is what the row remembers.
  const { compileInteractionSurface } = await import("@matebot/a2ui-adapter");
  const compiled = await compileInteractionSurface({
    schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
    values: {},
    surfaceId,
    result: surface,
    title: surface.title,
  });
  if (!compiled.ok) return { ok: false, error: compiled.error };

  const plan = resultPlan({ intent: input.intent, surface });
  const documentRef = a2uiSurfaceDocumentRef({ interactionId: "", surfaceId });

  let committed: { interactionId: string; messageId: string; eventSeq: number };
  try {
    committed = await deps.prisma.$transaction(async (tx) => {
      const interaction = await tx.interaction.create({
        data: {
          spaceId: input.spaceId,
          threadId: input.threadId,
          runId: input.runId ?? null,
          intent: input.intent,
          cardKey: interactionCardKey(input.threadId, input.intent),
          // A result is terminal on arrival: it has nothing to confirm.
          status: "succeeded",
          plan: plan as never,
          slots: {} as never,
          title: surface.title,
          summary: surface.provenance.source,
        },
        select: { id: true, draftVersion: true },
      });
      const ref = a2uiSurfaceDocumentRef({ interactionId: interaction.id, surfaceId });
      await tx.interactionSurface.upsert({
        where: { interactionId_surfaceId: { interactionId: interaction.id, surfaceId } },
        create: {
          interactionId: interaction.id,
          surfaceId,
          protocolFamily: compiled.protocolFamily,
          document: compiled.messages as never,
          draftVersion: interaction.draftVersion,
        },
        update: {
          document: compiled.messages as never,
          draftVersion: interaction.draftVersion,
        },
      });
      const block: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: interaction.id,
        surfaceId,
        protocolFamily: compiled.protocolFamily,
        draftVersion: interaction.draftVersion,
        intent: input.intent,
        title: surface.title,
        summary: surface.provenance.source,
        documentRef: ref,
        template: "action-result-success",
        lifecycle: "succeeded",
      };
      // The repo's own helper keeps message sequence and unread state correct.
      const { createThreadMessageInTransaction } = await import("@matebot/db");
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        botId: input.botId,
        runId: input.runId,
        role: "bot",
        blocks: [block],
      });
      await tx.interaction.update({
        where: { id: interaction.id },
        data: { messageId: message.id },
      });
      const event = await deps.appendEvent(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        runId: input.runId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks: [block] },
      });
      return { interactionId: interaction.id, messageId: message.id, eventSeq: event.seq };
    });
  } catch {
    return { ok: false, error: "result_publish_failed" };
  }

  await deps.notify(input.threadId, committed.eventSeq).catch(() => undefined);
  void documentRef;
  return {
    ok: true,
    interactionId: committed.interactionId,
    surfaceId,
    messageId: committed.messageId,
    eventSeq: committed.eventSeq,
  };
}

export type RepublishResultSurfaceInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId?: string;
  interactionId: string;
  surface: ResultSurface;
};

/**
 * Update the surface of an existing result interaction in place.
 *
 * This is a same-card refresh: the interaction keeps its id, the draft revision
 * moves forward, the surface document and the timeline block are rewritten, and
 * the SSE event tells the host to re-render. It creates no new card and no effect.
 */
export async function republishResultSurface(
  deps: ResultPublishDeps,
  input: RepublishResultSurfaceInput,
): Promise<
  | { ok: true; interactionId: string; surfaceId: string; draftVersion: number; eventSeq: number }
  | { ok: false; error: string }
> {
  const parsed = ResultSurfaceSchema.safeParse(input.surface);
  if (!parsed.success) return { ok: false, error: "invalid_result_surface" };
  const surface = parsed.data;

  const existing = await deps.prisma.interaction.findFirst({
    where: { id: input.interactionId, spaceId: input.spaceId, threadId: input.threadId },
    select: { id: true, messageId: true, draftVersion: true, summary: true },
  });
  if (!existing) return { ok: false, error: "unknown_interaction" };

  // A republish is a view change on the card the user is looking at. The stored
  // summary is the source it was drawn from; relabelling the same card with a
  // different source would present other data under a name the reader already
  // trusted, so that is refused here rather than left to each caller (§5.6.3).
  if (existing.summary && existing.summary !== surface.provenance.source) {
    return { ok: false, error: "source_changed" };
  }

  const surfaceRow = await deps.prisma.interactionSurface.findFirst({
    where: { interactionId: existing.id },
    orderBy: { updatedAt: "desc" },
    select: { surfaceId: true, protocolFamily: true },
  });
  if (!surfaceRow) return { ok: false, error: "unknown_surface" };

  const { compileInteractionSurface } = await import("@matebot/a2ui-adapter");
  const compiled = await compileInteractionSurface({
    schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
    values: {},
    surfaceId: surfaceRow.surfaceId,
    result: surface,
    title: surface.title,
  });
  if (!compiled.ok) return { ok: false, error: compiled.error };

  const nextVersion = existing.draftVersion + 1;
  let eventSeq = 0;
  try {
    eventSeq = await deps.prisma.$transaction(async (tx) => {
      await tx.interaction.updateMany({
        where: { id: existing.id, draftVersion: existing.draftVersion },
        data: {
          draftVersion: nextVersion,
          plan: resultPlan({ intent: "interaction.result", surface }) as never,
          title: surface.title,
          summary: surface.provenance.source,
        },
      });
      await tx.interactionSurface.upsert({
        where: {
          interactionId_surfaceId: { interactionId: existing.id, surfaceId: surfaceRow.surfaceId },
        },
        create: {
          interactionId: existing.id,
          surfaceId: surfaceRow.surfaceId,
          protocolFamily: compiled.protocolFamily,
          document: compiled.messages as never,
          draftVersion: nextVersion,
        },
        update: { document: compiled.messages as never, draftVersion: nextVersion },
      });
      // An in-place result update keeps the connection's label: the card is the same card, and
      // rebuilding it here would blank the sender row the moment the result arrives.
      const existingBlocks = existing.messageId
        ? ((await tx.message.findUnique({ where: { id: existing.messageId } }))?.blocks as
            | MessageBlock[]
            | undefined)
        : undefined;
      const keptSender = senderStampFromBlock(existingBlocks, surfaceRow.surfaceId);
      const block: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: existing.id,
        surfaceId: surfaceRow.surfaceId,
        protocolFamily: compiled.protocolFamily,
        draftVersion: nextVersion,
        intent: "interaction.result",
        title: surface.title,
        summary: surface.provenance.source,
        documentRef: a2uiSurfaceDocumentRef({
          interactionId: existing.id,
          surfaceId: surfaceRow.surfaceId,
        }),
        template: "action-result-success",
        lifecycle: "succeeded",
        ...(keptSender.senderLabel ? { senderLabel: keptSender.senderLabel } : {}),
        ...(keptSender.senderAddress ? { senderAddress: keptSender.senderAddress } : {}),
      };
      if (existing.messageId) {
        const message = await tx.message.findUnique({ where: { id: existing.messageId } });
        const blocks = Array.isArray(message?.blocks)
          ? (message.blocks as MessageBlock[]).map((entry) =>
              entry.kind === "a2ui_surface" && entry.surfaceId === surfaceRow.surfaceId
                ? block
                : entry,
            )
          : [block];
        await tx.message.update({
          where: { id: existing.messageId },
          data: { blocks: blocks as never },
        });
      }
      const event = await deps.appendEvent(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        runId: input.runId,
        type: "thread.surface.updated",
        payload: {
          interactionId: existing.id,
          surfaceId: surfaceRow.surfaceId,
          protocolFamily: compiled.protocolFamily,
          draftVersion: nextVersion,
          intent: "interaction.result",
          title: surface.title,
          summary: surface.provenance.source,
          messageId: existing.messageId ?? undefined,
          template: "action-result-success",
          lifecycle: "succeeded",
        },
      });
      return event.seq;
    });
  } catch (cause) {
    // Keep the underlying reason reachable without changing the contract.
    getLogger().warn("result surface republish failed", { cause });
    return { ok: false, error: "result_republish_failed" };
  }

  await deps.notify(input.threadId, eventSeq).catch(() => undefined);
  return {
    ok: true,
    interactionId: existing.id,
    surfaceId: surfaceRow.surfaceId,
    draftVersion: nextVersion,
    eventSeq,
  };
}
