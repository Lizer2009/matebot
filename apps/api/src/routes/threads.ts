import { runContinueJob, runJobKey } from "@matebot/adapter-kit";
import { settleCallRequest } from "@matebot/adapters";
import type { Actor, ProductEvent } from "@matebot/contracts";
import { a2uiSurfaceDocumentRef, parseA2uiSurfaceDocumentRef } from "@matebot/contracts";
import {
  AttachmentValidationError,
  CALL_CLIENT_NONCE_PREFIX,
  callClientNonce,
  expandSkillReferencesInPrompt,
  interactionCapabilityForIntent,
  MODEL_REQUIRED_SEND_ERROR,
  QUEUE_HOLDING_RUN_STATUSES,
} from "@matebot/core";
import type { Prisma } from "@matebot/db";
import {
  AnswerTooLongError,
  appendEventInTransaction,
  createExternalConversationRepos,
  createThreadMessageInTransaction,
  getInteraction,
  getInteractionSurface,
  InteractionNotFoundError,
  InteractionVersionConflictError,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
} from "@matebot/db";
import { getLogger } from "@matebot/logging";
import { ORPCError } from "@orpc/server";
import { isA2uiFeatureEnabled } from "../a2ui-feature.js";
import { dispatchInteractionActionService } from "../interaction-dispatch.js";
import { applyNaturalLanguageEdit } from "../interaction-nl-edit.js";
import { confirmThenExecute } from "../interaction-run-action.js";
import {
  confirmInteractionService,
  executeConfirmedInteractionService,
  InteractionEffectRunMissingError,
  InteractionEmailDeliveryError,
  InteractionSendRejectedError,
  reconcileConfirmedInteractionService,
  updateInteractionFieldService,
} from "../interaction-service.js";
import type { RouterDeps } from "../router.js";
import { createRoutineTestRun, routineTestRunNonce, routineTestTarget } from "../routines.js";
import { withSerializableRetry } from "../serializable-retry.js";
import { assertTeachingSendAllowed } from "../taught-skills.js";
import {
  isBackgroundRun,
  isPeerRun,
  loadMessagePage,
  shouldForwardBackgroundThreadEvent,
  shouldForwardPeerThreadEvent,
} from "../thread-message-pages.js";
import type { ThreadTarget } from "../thread-target.js";
import {
  isStopMessage,
  markThreadRead,
  markThreadUnreadFrom,
  reactToThreadMessage,
  resolveThreadTarget,
  sendTargetBotIds,
  sendThreadMessage,
  setThreadUnreadState,
  stopThreadRuns,
  threadHead,
  threadSnapshot,
} from "../thread-target.js";
import { mapBotSecretInputError } from "./bots.js";
import { releaseComputerControl } from "./computer.js";
import type { RouterContext } from "./context.js";
import {
  botsRunOwnModels,
  computerContext,
  HEARTBEAT_MS,
  isUniqueViolation,
  modelSetup,
  SESSION_RECHECK_MS,
  THREAD_MESSAGE_PAGE_SIZE,
} from "./shared.js";

/** Deterministic nonce for a call's marker message. The unique (threadId, clientNonce)
 * index makes it the hang-up idempotency key, and the "call:" prefix lets clients derive
 * the marker's callId. User turns carry a uuid suffix, so they never collide. */
export function callMarkerClientNonce(callId: string): string {
  return `${CALL_CLIENT_NONCE_PREFIX}${callId}:marker`;
}

function assertA2uiEnabled(): void {
  if (!isA2uiFeatureEnabled()) {
    throw new ORPCError("NOT_FOUND", { message: "A2UI is not enabled" });
  }
}

async function resolveInteractionBotId(
  prisma: RouterDeps["prisma"],
  target: ThreadTarget,
  interactionId: string,
): Promise<string> {
  if (target.kind === "bot") return target.botId;
  const interaction = await getInteraction(prisma, interactionId);
  if (!interaction || interaction.threadId !== target.threadId) {
    throw new ORPCError("NOT_FOUND", { message: "Interaction not found" });
  }
  if (interaction.runId) {
    const run = await prisma.run.findUnique({
      where: { id: interaction.runId },
      select: { botId: true },
    });
    if (run?.botId) return run.botId;
  }
  if (interaction.messageId) {
    const message = await prisma.message.findUnique({
      where: { id: interaction.messageId },
      select: { botId: true },
    });
    if (message?.botId) return message.botId;
  }
  throw new ORPCError("BAD_REQUEST", {
    message: "Could not resolve bot for this interaction",
  });
}

/** The card is closed by a marker; the run that follows finishes whatever the call left open. */
const HANG_UP_PROMPT =
  "The voice call just ended because the user hung up. First call end_call with a short title for the call (leave farewell empty). Then, if anything the user asked for during the call is still unfinished, complete it now as a normal chat reply with full formatting. If nothing is pending, reply with one short sentence.";

/** A send with routines that already has runs saved under its nonce. */
class SavedSubmission extends Error {}

/** A chat reply hands the screen back to the bot whose run it steers, in a group as in a DM. */
export function takeoverReleaser(deps: RouterDeps, actor: Actor, target: ThreadTarget) {
  return async (runId: string) => {
    const botId =
      target.kind === "bot"
        ? target.botId
        : (
            await deps.prisma.run.findUnique({
              where: { id: runId, spaceId: actor.spaceId },
              select: { botId: true },
            })
          )?.botId;
    if (botId) await releaseComputerControl(deps, actor, botId, "done", runId);
  };
}

export function threadsRoutes(ctx: RouterContext) {
  const { deps, authed, callsEnabled, codexCatalog, repos, agentSkills } = ctx;
  /** The bot a reaction can wake: the thread's bot, or in a group the bot that wrote the message. */
  const reactedBotId = async (target: ThreadTarget, messageId: string) =>
    target.kind === "bot"
      ? target.botId
      : ((
          await deps.prisma.message.findFirst({
            where: { id: messageId, threadId: target.threadId },
            select: { botId: true },
          })
        )?.botId ?? target.memberBotIds[0]!);
  const send = async (
    actor: Actor,
    input: Parameters<typeof sendThreadMessage>[3] & { botId?: string; groupId?: string },
    startRoutines?: Parameters<typeof sendThreadMessage>[5],
  ) => {
    const setup = await modelSetup(deps, actor);
    const target = await resolveThreadTarget(deps.prisma, actor, input);
    // A bot with its own runnable model needs no main model, and stopping work needs none.
    const noModel =
      setup.needsModel && !(await botsRunOwnModels(deps, actor, sendTargetBotIds(target, input)));
    if (noModel && (target.kind !== "bot" || !isStopMessage(input))) {
      throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
    }
    if (target.kind === "bot") {
      await assertTeachingSendAllowed(deps.prisma, actor.spaceId, target.botId);
    }
    const confirmingImages =
      input.imageHandling === "confirm" && Boolean(input.artifactIds?.length);
    // Reuse the funding modelSetup resolved; a send never asks billing twice.
    const deployment = setup.hasDeployment
      ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
      : null;
    return sendThreadMessage(
      {
        ...deps,
        maxAttachmentsPerMessage: deps.env.maxAttachmentsPerMessage,
        imageAdmission: confirmingImages
          ? {
              secrets: deps.secrets,
              deployment,
              hostedProvider: setup.creditsAvailable ? deployment?.provider : undefined,
              codexCatalog,
            }
          : undefined,
      },
      actor,
      target,
      { ...input, noModel },
      takeoverReleaser(deps, actor, target),
      startRoutines,
    ).catch((error: unknown) => {
      if (error instanceof AttachmentValidationError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    });
  };
  return {
    threads: {
      head: authed.threads.head.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return threadHead(deps.prisma, target);
      }),
      get: authed.threads.get.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        return threadSnapshot(deps, target);
      }),
      messages: authed.threads.messages.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        return loadMessagePage(
          deps.prisma,
          target.threadId,
          input.before,
          THREAD_MESSAGE_PAGE_SIZE,
          input.around,
          input.includePeerRuns,
          input.includePeerReceipts,
        );
      }),
      subscribe: authed.threads.subscribe.handler(async function* ({ context, input }) {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const peerRunCache = new Map<string, Promise<boolean>>();
        const backgroundRunCache = new Map<string, Promise<boolean>>();
        const follow = deps.events.follow(target.threadId, input.cursor, context.signal);
        // A half-open stream looks identical to an idle one, so punctuate silence:
        // the client treats any frame as liveness and reconnects once they stop.
        let pending: Promise<IteratorResult<ProductEvent>> | undefined;
        // Auth ran once when the stream opened. Re-check before delivering more, so a signed-out
        // or revoked session stops within SESSION_RECHECK_MS, or at the next heartbeat when idle.
        let authorizedAt = Date.now();
        const assertStillAuthorized = async () => {
          if (!context.stillAuthorized || Date.now() - authorizedAt < SESSION_RECHECK_MS) return;
          if (!(await context.stillAuthorized())) throw new ORPCError("UNAUTHORIZED");
          authorizedAt = Date.now();
        };
        try {
          while (!context.signal?.aborted) {
            pending ??= follow.next();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([
              pending,
              new Promise<"silent">((resolve) => {
                timer = setTimeout(() => resolve("silent"), HEARTBEAT_MS);
              }),
            ]).finally(() => clearTimeout(timer));
            if (next === "silent") {
              await assertStillAuthorized();
              // Keep `pending` so the in-flight read stays the next event in order.
              yield {
                id: "heartbeat",
                spaceId: context.actor.spaceId,
                threadId: target.threadId,
                // A bot thread's id is not the bot. Groups have no single bot, so the thread id stands in.
                botId: target.kind === "bot" ? target.botId : target.threadId,
                seq: 0,
                type: "heartbeat",
                createdAt: new Date().toISOString(),
                payload: {},
              };
              continue;
            }
            pending = undefined;
            if (next.done) return;
            const event = next.value;
            // Filtered peer events also restart the heartbeat, so check before skipping them.
            await assertStillAuthorized();
            if (await isPeerRun(deps.prisma, event.runId, peerRunCache)) {
              if (!shouldForwardPeerThreadEvent(event)) continue;
            } else if (await isBackgroundRun(deps.prisma, event.runId, backgroundRunCache)) {
              if (!shouldForwardBackgroundThreadEvent(event)) continue;
            }
            yield event;
          }
        } finally {
          // Not awaited: closing can queue behind a read that the abort has not landed on yet.
          void follow.return(undefined).catch(() => {});
        }
      }),
      send: authed.threads.send.handler(({ context, input }) => send(context.actor, input)),
      sendWithRoutines: authed.threads.sendWithRoutines.handler(async ({ context, input }) => {
        const { actor } = context;
        // The same checks as routines/testRun, all before anything is written.
        const targets = await Promise.all(
          [...new Set(input.routineIds)].map((routineId) =>
            routineTestTarget(deps.prisma, repos, actor, routineId),
          ),
        );
        const skillRecords = await agentSkills.listWithContent(actor);
        const routines = targets.map((target) => ({
          target,
          prompt: expandSkillReferencesInPrompt(target.routine.prompt, skillRecords),
          nonce: routineTestRunNonce(
            actor,
            `routine-mention:${input.clientNonce}:${target.routine.id}`,
          ),
        }));
        const nonces = routines.map((routine) => routine.nonce);
        const savedRuns = (db: Pick<Prisma.TransactionClient, "run">) =>
          db.run.findMany({
            where: { spaceId: actor.spaceId, userId: actor.userId, clientNonce: { in: nonces } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true },
          });
        const startRoutines = async (tx: Prisma.TransactionClient) => {
          // Any saved run means this submission was accepted; it is replayed, never extended. A
          // run another request commits after this lookup fails the insert below the same way.
          if ((await savedRuns(tx)).length) throw new SavedSubmission();
          const runs = [];
          for (const routine of routines) {
            runs.push(
              await createRoutineTestRun(tx, actor, routine.target, routine.prompt, routine.nonce),
            );
          }
          return runs;
        };
        let sent: Awaited<ReturnType<typeof send>> | undefined;
        try {
          if (input.text?.trim() || input.artifactIds?.length) {
            // A saved message for this nonce is replayed before any of this runs.
            sent = await send(actor, input, startRoutines);
          } else {
            // Only the routines: they all commit or none does.
            const started = await withSerializableRetry(() =>
              deps.prisma.$transaction(startRoutines),
            );
            for (const run of started) {
              await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
                getLogger().error("routine mention enqueue", error);
              });
            }
          }
        } catch (error) {
          // A concurrent retry that saved the same runs first wins on the unique key.
          const replay =
            error instanceof SavedSubmission ||
            (isUniqueViolation(error) && (await savedRuns(deps.prisma)).length > 0);
          if (!replay) throw error;
        }
        return {
          routineRunIds: (await savedRuns(deps.prisma)).map((run) => run.id),
          send: sent,
        };
      }),
      react: authed.threads.react.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        // Without a model or while teaching, the reaction is still saved; it just starts no turn.
        const mayStartTurn =
          (!(await modelSetup(deps, context.actor)).needsModel ||
            (await botsRunOwnModels(deps, context.actor, [
              await reactedBotId(target, input.messageId),
            ]))) &&
          (target.kind !== "bot" ||
            (await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId).then(
              () => true,
              () => false,
            )));
        const result = await reactToThreadMessage(
          deps,
          context.actor,
          target,
          { ...input, mayStartTurn },
          takeoverReleaser(deps, context.actor, target),
        );
        if (result.eventSeq != null) {
          await deps.events.notify(target.threadId, result.eventSeq).catch((error) => {
            getLogger().error("thread reaction realtime notification", error);
          });
        }
        return { ok: true as const, runIds: result.runIds };
      }),
      stop: authed.threads.stop.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await stopThreadRuns(deps, context.actor, target);
        return { ok: true as const };
      }),
      clear: authed.threads.clear.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const contextBotId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
        if (!contextBotId) throw new IsolationError();
        const { cancelledRunIds, historyCompactionGeneration } = await deps.events.clearThread({
          spaceId: context.actor.spaceId,
          threadId: target.threadId,
          botId: contextBotId,
          ...(target.kind === "group" ? { groupId: target.groupId } : {}),
        });
        const [configuredMemory] = await Promise.all([
          target.kind === "bot"
            ? deps.memoryProviders.resolve(context.actor.spaceId).catch((error) => {
                getLogger().error("semantic memory resolution after thread clear failed", error);
                return null;
              })
            : Promise.resolve(null),
          Promise.all(
            cancelledRunIds.map((runId) =>
              deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
            ),
          ),
        ]);
        // Durable memories remain in their Space-private containers. Clear only removes
        // conversation-derived summaries from the previous generation; including the new
        // generation also covers a compaction job that began just after the clear committed.
        if (configuredMemory && target.kind === "bot") {
          // Best effort: the conversation rows are already deleted, so failing the clear here
          // would help nothing — a failed purge only leaves stale summaries recallable.
          try {
            const purged = await configuredMemory.provider.purgeHistory(
              {
                botId: target.botId,
                generations: [
                  Math.max(0, historyCompactionGeneration - 1),
                  historyCompactionGeneration,
                ],
              },
              computerContext(context.actor, target.botId, `thread-clear:${target.threadId}`),
            );
            if (!purged.ok) {
              getLogger().error("semantic memory purge after thread clear failed", purged.error);
            }
          } catch (error) {
            getLogger().error("semantic memory purge after thread clear failed", error);
          }
        }
        return { ok: true as const };
      }),
      followUp: authed.threads.followUp.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
          const sent = await deps.events.sendUserMessage({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            userId: context.actor.userId,
            blocks: [{ kind: "text", text: input.text }],
            prompt: input.text,
            trigger: "follow_up",
            clientNonce: input.clientNonce,
          });
          if (sent.taskId && sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              getLogger().error("follow-up enqueue", error);
            });
          }
          return { ok: true as const };
        }
        const committed = await deps.prisma.$transaction(async (tx) => {
          if (input.clientNonce) {
            const existing = await tx.message.findUnique({
              where: {
                threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
              },
            });
            if (existing) return null;
          }
          await lockOwnedGroup(tx, context.actor, target.groupId);
          const group = await tx.chatGroup.findFirst({
            where: {
              id: target.groupId,
              archivedAt: null,
              thread: { id: target.threadId },
            },
            include: { members: { orderBy: [{ createdAt: "asc" }, { botId: "asc" }] } },
          });
          const botId = group?.members[0]?.botId;
          if (!botId) throw new IsolationError();
          const blocks = [{ kind: "text" as const, text: input.text }];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: target.threadId,
            role: "user",
            blocks,
            clientNonce: input.clientNonce,
          });
          const active = await tx.run.findFirst({
            where: {
              threadId: target.threadId,
              botId,
              status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
            },
            select: { id: true },
          });
          let run: { id: string } | null = null;
          if (!active) {
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                userId: context.actor.userId,
                prompt: input.text,
                status: "queued",
              },
            });
            run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "follow_up",
                sourceMessageId: message.id,
              },
              select: { id: true },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
          } else {
            await tx.steeringMessage.create({
              data: {
                messageId: message.id,
                botId,
                userId: context.actor.userId,
                runId: active.id,
              },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId,
            type: "thread.message.created",
            runId: run?.id ?? active?.id,
            payload: { messageId: message.id, role: "user", blocks },
          });
          await touchGroupUpdatedAt(tx, target.groupId);
          return { runId: run?.id, eventSeq: event.seq, message };
        });
        if (committed) {
          deps.analytics?.capture(
            context.actor.userId,
            { name: "message_sent", trigger: "follow_up" },
            { id: committed.message.id, at: committed.message.createdAt },
          );
          await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
            getLogger().error("group follow-up realtime notification", error);
          });
          if (committed.runId) {
            await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
              getLogger().error("group follow-up enqueue", error);
            });
          }
        }
        return { ok: true as const };
      }),
      answerCall: callsEnabled.threads.answerCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        const answered = await settleCallRequest(deps, {
          threadId: target.threadId,
          callId: input.callId,
          from: ["ringing"],
          status: "answered",
        });
        if (answered?.status !== "answered")
          throw new ORPCError("CONFLICT", { message: "This call is no longer ringing." });
        return { opening: answered.opening, reason: answered.reason };
      }),
      declineCall: callsEnabled.threads.declineCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        const declined = await settleCallRequest(deps, {
          threadId: target.threadId,
          callId: input.callId,
          from: ["ringing"],
          status: input.outcome,
        });
        if (declined?.status !== input.outcome)
          throw new ORPCError("CONFLICT", { message: "This call is no longer ringing." });
        return { ok: true as const };
      }),
      endCall: callsEnabled.threads.endCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
        const { botId, threadId } = target;
        // The bot's own call: its card keeps how long the user stayed on.
        await settleCallRequest(deps, {
          threadId,
          callId: input.callId,
          from: ["answered"],
          ...(input.durationSeconds === undefined
            ? {}
            : { durationSeconds: input.durationSeconds }),
        });
        const blocks = [
          {
            kind: "voice_call" as const,
            callId: input.callId,
            title: "",
            farewell: "",
            ...(input.durationSeconds === undefined
              ? {}
              : { durationSeconds: input.durationSeconds }),
          },
        ];
        const committed = await deps.prisma
          .$transaction(async (tx) => {
            // A late provider hang-up is harmless when the call never produced a
            // user utterance; do not create a phantom marker or follow-up run.
            const userUtterance = await tx.message.findFirst({
              where: {
                threadId,
                role: "user",
                clientNonce: { startsWith: `${CALL_CLIENT_NONCE_PREFIX}${input.callId}:` },
              },
              select: { id: true },
            });
            if (!userUtterance) return null;
            // The marker's deterministic nonce is the idempotency key: the unique
            // (threadId, clientNonce) index rejects a second hang-up, concurrent or not.
            const message = await createThreadMessageInTransaction(tx, {
              threadId,
              role: "bot",
              botId,
              blocks,
              clientNonce: callMarkerClientNonce(input.callId),
            });
            await appendEventInTransaction(tx, {
              spaceId: context.actor.spaceId,
              threadId,
              botId,
              type: "thread.message.created",
              payload: { messageId: message.id, role: "bot", blocks, callId: input.callId },
            });
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId,
                userId: context.actor.userId,
                prompt: HANG_UP_PROMPT,
                status: "queued",
              },
            });
            const run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "call_end",
                clientNonce: callClientNonce(input.callId),
              },
              select: { id: true },
            });
            const ended = await appendEventInTransaction(tx, {
              spaceId: context.actor.spaceId,
              threadId,
              botId,
              type: "thread.call.ended",
              runId: run.id,
              payload: {
                botId,
                threadId,
                callId: input.callId,
                title: "",
                farewell: "",
                messageId: message.id,
              },
            });
            return { runId: run.id, eventSeq: ended.seq };
          })
          .catch((error) => {
            if (!isUniqueViolation(error)) throw error;
            return null;
          });
        if (!committed) return { ok: true as const };
        await deps.events.notify(threadId, committed.eventSeq).catch((error) => {
          getLogger().error("call end realtime notification", error);
        });
        // The queued run is durable; a missed wake is repaired by the reconciler.
        await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
          getLogger().error("call end enqueue", error);
        });
        return { ok: true as const };
      }),
      answer: authed.threads.answer.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const answered = await deps.events
          .answerRunInput({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            runId: input.runId,
            messageId: input.messageId,
            answeredByUserId: context.actor.userId,
            answer: input.answer,
            clientNonce: input.clientNonce,
            fields: input.fields,
            username: input.username,
            remember: input.remember,
            dismiss: input.dismiss,
          })
          .catch((error: unknown) => {
            if (error instanceof AnswerTooLongError)
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            // A typed credential its destination cannot carry (e.g. a header with a line break).
            throw mapBotSecretInputError(error);
          });
        if (!answered) {
          throw new ORPCError("CONFLICT", {
            message: "This prompt is no longer awaiting an answer",
          });
        }
        await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
          // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
          getLogger().error("thread answer enqueue", error);
        });
        return { ok: true as const };
      }),
      getA2uiSurface: authed.threads.getA2uiSurface.handler(async ({ context, input }) => {
        assertA2uiEnabled();
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        const ids = input.documentRef
          ? parseA2uiSurfaceDocumentRef(input.documentRef)
          : input.interactionId && input.surfaceId
            ? { interactionId: input.interactionId, surfaceId: input.surfaceId }
            : null;
        if (!ids) {
          throw new ORPCError("BAD_REQUEST", { message: "Invalid A2UI surface reference" });
        }
        const interaction = await getInteraction(deps.prisma, ids.interactionId);
        if (!interaction || interaction.threadId !== target.threadId) {
          throw new ORPCError("NOT_FOUND", { message: "Interaction not found" });
        }
        const surface = await getInteractionSurface(deps.prisma, ids);
        if (!surface) {
          throw new ORPCError("NOT_FOUND", { message: "Surface not found" });
        }
        const protocolFamily =
          surface.protocolFamily === "v0_9" || surface.protocolFamily === "v1_0"
            ? surface.protocolFamily
            : null;
        if (!protocolFamily) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: "Surface protocolFamily is invalid",
          });
        }
        const messages = Array.isArray(surface.document) ? surface.document : [];
        return {
          interactionId: surface.interactionId,
          surfaceId: surface.surfaceId,
          protocolFamily,
          draftVersion: surface.draftVersion,
          messages,
          documentRef: a2uiSurfaceDocumentRef(ids),
        };
      }),
      updateInteractionField: authed.threads.updateInteractionField.handler(
        async ({ context, input }) => {
          assertA2uiEnabled();
          const target = await resolveThreadTarget(deps.prisma, context.actor, input);
          const botId = await resolveInteractionBotId(deps.prisma, target, input.interactionId);
          try {
            const result = await updateInteractionFieldService(deps.prisma, {
              spaceId: context.actor.spaceId,
              threadId: target.threadId,
              botId,
              interactionId: input.interactionId,
              expectedDraftVersion: input.expectedDraftVersion,
              name: input.name,
              value: input.value,
            });
            return { ok: true as const, draftVersion: result.draftVersion };
          } catch (error) {
            if (error instanceof InteractionNotFoundError) {
              throw new ORPCError("NOT_FOUND", { message: "Interaction not found" });
            }
            if (error instanceof InteractionVersionConflictError) {
              throw new ORPCError("CONFLICT", {
                message: "Interaction draft was updated elsewhere; reload and retry",
              });
            }
            throw error;
          }
        },
      ),
      confirmInteraction: authed.threads.confirmInteraction.handler(async ({ context, input }) => {
        assertA2uiEnabled();
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const botId = await resolveInteractionBotId(deps.prisma, target, input.interactionId);
        try {
          const result = await confirmInteractionService(deps.prisma, {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId,
            interactionId: input.interactionId,
            draftVersion: input.draftVersion,
            userId: context.actor.userId,
            connector: deps.connectors,
          });
          return {
            ok: true as const,
            confirmedVersion: result.confirmedVersion,
            effectId: result.effectId,
            idempotencyKey: result.idempotencyKey,
          };
        } catch (error) {
          if (error instanceof InteractionNotFoundError) {
            throw new ORPCError("NOT_FOUND", { message: "Interaction not found" });
          }
          if (error instanceof InteractionVersionConflictError) {
            throw new ORPCError("CONFLICT", {
              message: "Interaction draft was updated elsewhere; reload and retry",
            });
          }
          if (
            error instanceof InteractionEffectRunMissingError ||
            error instanceof InteractionSendRejectedError
          ) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          if (
            error instanceof Error &&
            (error.message.includes("Required fields") ||
              error.message.includes("cannot be confirmed") ||
              /\bnot ready\b/i.test(error.message))
          ) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      executeInteraction: authed.threads.executeInteraction.handler(async ({ context, input }) => {
        assertA2uiEnabled();
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const botId = await resolveInteractionBotId(deps.prisma, target, input.interactionId);
        try {
          const result = await executeConfirmedInteractionService(deps.prisma, {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId,
            interactionId: input.interactionId,
            userId: context.actor.userId,
            connector: deps.connectors,
            jobs: deps.jobs,
          });
          return { ok: true as const, ...result };
        } catch (error) {
          if (error instanceof InteractionNotFoundError) {
            throw new ORPCError("NOT_FOUND", { message: "Interaction not found" });
          }
          if (
            error instanceof InteractionSendRejectedError ||
            error instanceof InteractionEmailDeliveryError
          ) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw new ORPCError("BAD_REQUEST", { message: "Could not send the email" });
        }
      }),
      editInteraction: authed.threads.editInteraction.handler(async ({ context, input }) => {
        assertA2uiEnabled();
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const interactions = await deps.prisma.interaction.findMany({
          where: {
            threadId: target.threadId,
            status: { notIn: ["cancelled", "failed", "unknown"] },
          },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            intent: true,
            status: true,
            draftVersion: true,
            title: true,
            summary: true,
            surfaces: { select: { surfaceId: true }, orderBy: { updatedAt: "desc" }, take: 1 },
          },
        });
        const open = interactions
          .filter((row) => row.surfaces.length > 0)
          .map((row) => ({
            taskId: row.id,
            surfaceId: row.surfaces[0]!.surfaceId,
            intent: row.intent,
            label: row.title ?? row.summary ?? row.intent,
            status:
              row.status === "succeeded"
                ? ("executed" as const)
                : row.status === "awaiting_approval"
                  ? ("approved" as const)
                  : ("draft" as const),
          }));
        // The schema comes from the registry for the card being edited, so a
        // model cannot widen the fields by proposing them.
        const chosenId = input.interactionId ?? (open.length === 1 ? open[0]!.taskId : undefined);
        const chosen = chosenId ? open.find((row) => row.taskId === chosenId) : undefined;
        const capability = interactionCapabilityForIntent(chosen?.intent ?? "");
        const botId = chosen
          ? await resolveInteractionBotId(deps.prisma, target, chosen.taskId)
          : null;
        const result = await applyNaturalLanguageEdit(
          {
            loadInteraction: async (interactionId) => {
              const row = await getInteraction(deps.prisma, interactionId);
              if (!row) return null;
              return {
                id: row.id,
                spaceId: row.spaceId,
                threadId: row.threadId,
                intent: row.intent,
                status: row.status,
                draftVersion: row.draftVersion,
                confirmedVersion: row.confirmedVersion,
                slots: (row.slots ?? {}) as Record<string, unknown>,
              };
            },
            listOpenSurfaces: async () => open,
            applyField: async (fieldInput) => {
              await updateInteractionFieldService(deps.prisma, {
                spaceId: fieldInput.spaceId,
                threadId: fieldInput.threadId,
                botId: fieldInput.botId || botId || "",
                interactionId: fieldInput.interactionId,
                expectedDraftVersion: fieldInput.expectedDraftVersion,
                name: fieldInput.name,
                value: fieldInput.value,
              });
              return { draftVersion: fieldInput.expectedDraftVersion + 1 };
            },
          },
          {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId: botId ?? undefined,
            interactionId: input.interactionId,
            // Without a registered capability there is nothing to edit safely.
            schema: capability?.schema ?? {
              schemaVersion: 1,
              presentation: "result",
              fields: [],
              action: null,
            },
            fields: input.fields,
            revision: input.revision,
            userEditedFields: input.userEditedFields,
          },
        );
        if (!result.ok) throw new ORPCError("BAD_REQUEST", { message: result.error });
        // The field service already emitted thread.surface.updated; nothing else to fan out.
        return {
          ok: true as const,
          interactionId: result.interactionId,
          surfaceId: result.surfaceId,
          draftVersion: result.draftVersion,
          skippedFields: result.skippedFields,
          confirmationInvalidated: result.confirmationInvalidated,
          nudge: result.nudge,
        };
      }),
      dispatchInteractionAction: authed.threads.dispatchInteractionAction.handler(
        async ({ context, input }) => {
          assertA2uiEnabled();
          const target = await resolveThreadTarget(deps.prisma, context.actor, input);
          const botId = await resolveInteractionBotId(deps.prisma, target, input.interactionId);
          // A compiled surface's single button arrives as an action id plus the
          // revision it was rendered from; the service re-checks both.
          const capability = interactionCapabilityForIntent(
            (await getInteraction(deps.prisma, input.interactionId))?.intent ?? "",
          );
          if (!capability) {
            throw new ORPCError("BAD_REQUEST", { message: "No capability for this interaction" });
          }
          const result = await dispatchInteractionActionService(
            {
              loadInteraction: async (interactionId) => {
                const row = await getInteraction(deps.prisma, interactionId);
                if (!row) return null;
                return {
                  id: row.id,
                  spaceId: row.spaceId,
                  threadId: row.threadId,
                  intent: row.intent,
                  // The surface's own status carries the executed record.
                  status:
                    row.status === "succeeded"
                      ? ("executed" as const)
                      : row.confirmedVersion !== null && row.confirmedVersion === row.draftVersion
                        ? ("approved" as const)
                        : ("draft" as const),
                  draftVersion: row.draftVersion,
                  confirmedVersion: row.confirmedVersion,
                  schema: capability.schema,
                };
              },
              loadSurface: (surfaceInput) => getInteractionSurface(deps.prisma, surfaceInput),
              runAction: async () => {
                // The compiled button runs the *existing* effect path, so there is
                // one execution route per capability rather than a second one here.
                return confirmThenExecute(
                  {
                    confirm: (confirmInput) =>
                      confirmInteractionService(deps.prisma, {
                        ...confirmInput,
                        connector: deps.connectors,
                      }),
                    execute: (executeInput) =>
                      executeConfirmedInteractionService(deps.prisma, {
                        ...executeInput,
                        connector: deps.connectors,
                        jobs: deps.jobs,
                      }),
                  },
                  {
                    spaceId: context.actor.spaceId,
                    threadId: target.threadId,
                    botId,
                    interactionId: input.interactionId,
                    revision: input.revision,
                    userId: context.actor.userId,
                    kind: capability.effectKind,
                  },
                );
              },
            },
            {
              spaceId: context.actor.spaceId,
              threadId: target.threadId,
              interactionId: input.interactionId,
              surfaceId: input.surfaceId,
              action: input.action,
              revision: input.revision,
            },
          );
          if (!result.ok) {
            // A refused click is a controlled outcome the card renders, not a 500.
            throw new ORPCError("BAD_REQUEST", { message: result.error });
          }
          return {
            ok: true as const,
            duplicate: result.duplicate,
            interactionId: result.interactionId,
            revision: result.revision,
          };
        },
      ),
      reconcileInteraction: authed.threads.reconcileInteraction.handler(
        async ({ context, input }) => {
          assertA2uiEnabled();
          const target = await resolveThreadTarget(deps.prisma, context.actor, input);
          const botId = await resolveInteractionBotId(deps.prisma, target, input.interactionId);
          try {
            const result = await reconcileConfirmedInteractionService(deps.prisma, {
              spaceId: context.actor.spaceId,
              threadId: target.threadId,
              botId,
              interactionId: input.interactionId,
              userId: context.actor.userId,
              connector: deps.connectors,
              jobs: deps.jobs,
            });
            return { ok: true as const, ...result };
          } catch (error) {
            if (error instanceof InteractionNotFoundError) {
              throw new ORPCError("NOT_FOUND", { message: "Interaction not found" });
            }
            if (error instanceof InteractionSendRejectedError) {
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            throw new ORPCError("BAD_REQUEST", { message: "Could not check send status" });
          }
        },
      ),
      markRead: authed.threads.markRead.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const unreadAfterSeq = await markThreadRead(deps.prisma, context.actor, target);
        return { ok: true as const, unreadAfterSeq };
      }),
      markUnread: authed.threads.markUnread.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (input.messageId) {
          await markThreadUnreadFrom(deps.prisma, context.actor, target, input.messageId);
        } else {
          await setThreadUnreadState(deps.prisma, context.actor, target, true);
        }
        return { ok: true as const };
      }),
    },
    externalConversations: {
      updatePolicy: authed.externalConversations.updatePolicy.handler(
        async ({ context, input }) => {
          const { externalConversationId, ...policy } = input;
          return createExternalConversationRepos(deps.prisma).updatePolicy(
            context.actor,
            externalConversationId,
            policy,
          );
        },
      ),
    },
  };
}
