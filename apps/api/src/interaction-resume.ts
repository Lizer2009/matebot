import type { InteractionPlan } from "@matebot/contracts";
import type { InteractionRequiredApp } from "@matebot/core";
import {
  connectionSatisfiesApp,
  emailSurfaceBlockFields,
  interactionRequiredApp,
} from "@matebot/core";
import type { Prisma, PrismaClient } from "@matebot/db";
import { appendEventInTransaction } from "@matebot/db";
import { getLogger } from "@matebot/logging";

/**
 * A connection can finish long after the turn that asked for it, so the chat has
 * to move on its own. Two cases, one hook: a surface that was waiting becomes
 * usable in place, and a turn that never got to present one gets a run to do it.
 * Both are keyed to this thread, so a connection made elsewhere starts nothing.
 */

export function interactionAppForProvider(provider: string): InteractionRequiredApp | undefined {
  if (connectionSatisfiesApp("email", provider)) return "email";
  if (connectionSatisfiesApp("calendar", provider)) return "calendar";
  return undefined;
}

/** The next fields a resumed surface asks for, in the user's own terms. */
const RESUME_FIELDS: Record<InteractionRequiredApp, string> = {
  email: 'intent "email.compose" with fields for to, subject, and body',
  calendar: 'intent "calendar.create" with a required name field and an optional events field',
};

/**
 * The hidden prompt for a chat whose turn ended at the connection card. It names
 * the surface, never credential steps: the card is where the work happens.
 */
export function interactionResumePrompt(input: {
  app: InteractionRequiredApp;
  provider: string;
}): string {
  const subject = input.app === "calendar" ? "calendar" : "email draft";
  return `The user just connected ${input.provider}, so continue what they asked for. Call present_interaction once for the ${subject} with ${RESUME_FIELDS[input.app]}, nextStep "ask" or "request_approval", and riskLevel "medium", filling in whatever you already know and leaving the rest missing. Then reply with one short sentence telling them to use the card. Ask for nothing in prose, do not restate the fields, and never claim the action happened.`;
}

export type ConnectionResumeResult = {
  refreshedInteractionIds: string[];
  queuedRunId: string | null;
};

type ResumeDeps = {
  prisma: PrismaClient;
  jobs?: {
    enqueue(job: { name: string; payload: unknown; replaceKey?: string }): Promise<unknown>;
  };
};

/**
 * Flip every surface waiting on this app back to an editable draft.
 *
 * Also reports whether the thread has a card waiting on some *other* app. That is not this
 * connection's business, and it means the chat is not idle: a model turn here would ask for a
 * draft the person never abandoned, next to a card still waiting for its own app.
 */
async function refreshWaitingInteractions(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    app: InteractionRequiredApp;
  },
): Promise<{ refreshed: string[]; waitingOnAnotherApp: boolean }> {
  const rows = await tx.interaction.findMany({
    // Space and thread together: a thread id is unique, but the scope belongs in the query that
    // writes, so a mistake upstream cannot let one space refresh another's card.
    where: { spaceId: input.spaceId, threadId: input.threadId, status: "needs_connection" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      intent: true,
      draftVersion: true,
      confirmedVersion: true,
      plan: true,
      messageId: true,
      title: true,
      summary: true,
      runId: true,
      surfaces: {
        select: { surfaceId: true, protocolFamily: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });
  const refreshed: string[] = [];
  let waitingOnAnotherApp = false;
  for (const row of rows) {
    if (interactionRequiredApp(row.intent) !== input.app) {
      // A card that waits on a different app is not a reason to start a turn, but it does mean
      // the chat already holds unfinished work.
      if (interactionRequiredApp(row.intent) !== undefined) waitingOnAnotherApp = true;
      continue;
    }
    const surface = row.surfaces[0];
    if (!surface) continue;
    const plan = row.plan as InteractionPlan;
    const stamps = emailSurfaceBlockFields({
      intent: plan.intent,
      capability: "ready",
      interactionStatus: "collecting",
    });
    await tx.interaction.updateMany({
      where: { id: row.id, draftVersion: row.draftVersion },
      data: { status: "collecting" },
    });
    const message = row.messageId
      ? await tx.message.findUnique({ where: { id: row.messageId }, select: { blocks: true } })
      : null;
    if (row.messageId && message) {
      const existing = Array.isArray(message.blocks) ? message.blocks : [];
      const nextBlocks = existing.map((entry) => {
        const block = entry as { kind?: string; surfaceId?: string };
        if (block.kind !== "a2ui_surface" || block.surfaceId !== surface.surfaceId) return entry;
        return { ...(entry as Record<string, unknown>), ...stamps, intent: plan.intent };
      });
      await tx.message.update({
        where: { id: row.messageId },
        data: { blocks: nextBlocks as Prisma.InputJsonValue },
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.updated",
        payload: { messageId: row.messageId, role: "bot", blocks: nextBlocks },
      });
    }
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.surface.updated",
      runId: row.runId ?? undefined,
      payload: {
        interactionId: row.id,
        surfaceId: surface.surfaceId,
        protocolFamily: surface.protocolFamily,
        draftVersion: row.draftVersion,
        intent: plan.intent,
        title: row.title ?? undefined,
        summary: row.summary ?? undefined,
        messageId: row.messageId ?? undefined,
        ...stamps,
      },
    });
    refreshed.push(row.id);
  }
  return { refreshed, waitingOnAnotherApp };
}

/** Queue one hidden-prompt run, unless the bot is already busy or gone from the chat. */
async function queueResumeRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string; botId: string; threadId: string; prompt: string },
): Promise<string | null> {
  const [bot, busy] = await Promise.all([
    tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
      select: { id: true },
    }),
    tx.run.findFirst({
      where: {
        threadId: input.threadId,
        botId: input.botId,
        status: { in: ["queued", "leased", "running", "waiting_takeover"] },
      },
      select: { id: true },
    }),
  ]);
  if (!bot || busy) return null;
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: input.userId,
      prompt: input.prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: input.userId,
      status: "queued",
      trigger: "user",
    },
    select: { id: true },
  });
  return run.id;
}

/**
 * Called after an app connection completes inside a chat. A surface that was
 * waiting on that app is made usable in place with no model turn; only when
 * nothing was waiting does the bot get a turn to present the surface it never
 * reached — the create-calendar case.
 */
export async function resumeInteractionAfterConnection(
  deps: ResumeDeps,
  input: {
    actor: { spaceId: string; userId: string };
    botId: string;
    threadId: string;
    provider: string;
    /** Whether the app can act at all, from the provider's own catalog. */
    appConnected: boolean;
  },
): Promise<ConnectionResumeResult> {
  const app = interactionAppForProvider(input.provider);
  if (!app || !input.appConnected) return { refreshedInteractionIds: [], queuedRunId: null };
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const outcome = await refreshWaitingInteractions(tx, {
      spaceId: input.actor.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      app,
    });
    // The refreshed card is already the next step; another run would only duplicate it.
    if (outcome.refreshed.length > 0) return { refreshed: outcome.refreshed, runId: null };
    // Nothing of this app's was waiting, but the chat is not idle: a card is still on screen
    // waiting for its own app. Starting a turn now would ask for a second draft beside it.
    if (outcome.waitingOnAnotherApp) return { refreshed: outcome.refreshed, runId: null };
    const runId = await queueResumeRun(tx, {
      spaceId: input.actor.spaceId,
      userId: input.actor.userId,
      botId: input.botId,
      threadId: input.threadId,
      prompt: interactionResumePrompt({ app, provider: input.provider }),
    });
    return { refreshed: outcome.refreshed, runId };
  });
  if (committed.runId) {
    try {
      await deps.jobs?.enqueue({
        name: "run.continue",
        payload: { runId: committed.runId },
        replaceKey: `run:${committed.runId}`,
      });
    } catch (error) {
      // The queued run is durable; the reconciler repairs a missed wake.
      getLogger().error("interaction resume enqueue", error);
    }
  }
  return {
    refreshedInteractionIds: committed.refreshed,
    queuedRunId: committed.runId,
  };
}
