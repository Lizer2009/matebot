import type { ConnectorRegistry } from "@matebot/adapters";
import { publishL0aView, settleInteraction } from "@matebot/adapters";
import type { Actor, MessageBlock } from "@matebot/contracts";
import type { L0aBlock } from "@matebot/core";
import {
  appConnectCard,
  connectedAppBlocks,
  isL0aBlock,
  l0aIntentForBlock,
  matchAppCatalog,
  matchesAppConnection,
  stampL0aBlock,
} from "@matebot/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@matebot/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
} from "@matebot/db";
import { getLogger } from "@matebot/logging";
import { requireBotThread } from "./bot-thread.js";
import { resumeInteractionAfterConnection } from "./interaction-resume.js";
import { resolveThreadTarget } from "./thread-target.js";

/**
 * First-run conversational onboarding, seeded deterministically into the bot's
 * thread: greeting, a focus choice, and available app cards the user authorizes
 * inline. Focus must not rename the bot. No model tokens are spent.
 */

type OnboardingDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
  connectors: ConnectorRegistry;
  /** Wakes the run that resumes a chat whose surface waited on the app. */
  jobs?: {
    enqueue(job: { name: string; payload: unknown; replaceKey?: string }): Promise<unknown>;
  };
};

type FocusOption = {
  id: string;
  letter: string;
  label: string;
  summary: string;
  apps: string[];
};

const FOCUS_OPTIONS: FocusOption[] = [
  {
    id: "day",
    letter: "A",
    label: "Day-to-day work",
    summary: "Slack, calendar, and email",
    apps: ["slack", "gmail", "googlecalendar"],
  },
  {
    id: "inbox",
    letter: "B",
    label: "Inbox & email",
    summary: "email and calendar",
    apps: ["gmail", "googlecalendar", "slack"],
  },
  {
    id: "research",
    letter: "C",
    label: "Research & writing",
    summary: "the web, notes, and docs",
    apps: ["hackernews", "notion", "googledocs"],
  },
  {
    id: "everything",
    letter: "D",
    label: "A bit of everything",
    summary: "Slack, calendar, and email",
    apps: ["slack", "gmail", "googlecalendar"],
  },
];

function l0aTitle(block: L0aBlock): string {
  if (block.kind === "choice") return block.question;
  if (block.kind === "ask") return block.text;
  if (block.kind === "mcp_approval") return block.name;
  return `Connect ${block.name}`;
}

async function post(
  deps: OnboardingDeps,
  target: { spaceId: string; botId: string; threadId: string },
  blocks: MessageBlock[],
  markUnread = true,
): Promise<string> {
  if (blocks.length > 1 && blocks.every(isL0aBlock)) {
    let last = "";
    for (const block of blocks) {
      last = await post(deps, target, [block], markUnread);
    }
    return last;
  }
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (only && isL0aBlock(only)) {
    const block = only;
    const published = await publishL0aView(deps.prisma, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      intent: l0aIntentForBlock(block),
      title: l0aTitle(block),
      status: block.kind === "app_connect" ? "needs_connection" : "collecting",
      block,
    });
    await deps.events.notify(target.threadId, published.eventSeq);
    return published.messageId;
  }
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "bot",
      markUnread,
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { message, event };
  });
  await deps.events.notify(target.threadId, committed.event.seq);
  return committed.message.id;
}

/** Sentinel answerId for a focus card the user dismissed without choosing. */
export const FOCUS_DISMISSED_ANSWER_ID = "_dismissed";

export async function startOnboarding(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { thread } = await requireBotThread(deps, actor, botId);
  const existing = await deps.prisma.message.count({ where: { threadId: thread.id } });
  if (existing > 0) return;
  // The focus card is posted later via promptFocus so non-first bots can wait ~10s for
  // free typing, or skip if the user already engaged.
}

/** A focus card, or a question the bot asked itself; either way the thread already asks. */
function messageHasChoiceOrAsk(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice" || block.kind === "ask");
}

function messageHasPendingChoice(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice" && !block.answerId);
}

export async function promptFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const blocks: MessageBlock[] = [
    {
      kind: "choice",
      question: "What do you want me on first?",
      options: FOCUS_OPTIONS.map(({ id, letter, label }) => ({ id, letter, label })),
    },
  ];
  // Check + insert + event in one transaction so concurrent promptFocus calls
  // cannot duplicate cards, and a concurrent user send cannot publish first.
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      select: { role: true, blocks: true },
      orderBy: { createdAt: "asc" },
    });
    if (recent.some((message) => message.role === "user")) return null;
    if (recent.some((message) => messageHasChoiceOrAsk(message.blocks as MessageBlock[])))
      return null;
    // A bot whose creation intro is running asks what it is for itself (see enqueueBotIntroRun).
    const intro = await tx.run.findFirst({
      where: {
        threadId: thread.id,
        trigger: "created",
        status: { notIn: ["failed", "cancelled"] },
      },
      select: { id: true },
    });
    if (intro) return null;
    return true;
  });
  if (!committed) return;
  const published = await publishL0aView(deps.prisma, {
    spaceId: target.spaceId,
    threadId: target.threadId,
    botId: target.botId,
    // Own occupancy slot so a later `question.clarify` ask cannot rewrite this card.
    intent: "question.focus",
    title: "What do you want me on first?",
    status: "collecting",
    block: blocks[0] as Extract<MessageBlock, { kind: "choice" }>,
  });
  await deps.events.notify(target.threadId, published.eventSeq);
}

export async function dismissFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) => {
      if (block.kind !== "choice" || block.answerId) return block;
      const dismissed = { ...block, answerId: FOCUS_DISMISSED_ANSWER_ID };
      return dismissed.interactionId
        ? stampL0aBlock(dismissed, {
            interactionId: dismissed.interactionId,
            cardStatus: "cancelled",
          })
        : dismissed;
    });
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    const dismissed = (blocks as MessageBlock[]).find(isL0aBlock);
    if (dismissed?.interactionId) {
      await settleInteraction(tx as never, {
        interactionId: dismissed.interactionId,
        status: "cancelled",
        reason: "focus dismissed",
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);
}

export async function chooseFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  optionId: string,
): Promise<void> {
  const option = FOCUS_OPTIONS.find((entry) => entry.id === optionId);
  if (!option) throw new IsolationError();
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };

  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) => {
      if (block.kind !== "choice") return block;
      const chosen = { ...block, answerId: option.id };
      return chosen.interactionId
        ? stampL0aBlock(chosen, {
            interactionId: chosen.interactionId,
            cardStatus: "succeeded",
          })
        : chosen;
    });
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    const chosen = (blocks as MessageBlock[]).find(isL0aBlock);
    if (chosen?.interactionId) {
      await settleInteraction(tx as never, {
        interactionId: chosen.interactionId,
        status: "succeeded",
        reason: "focus chosen",
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);

  // Keep the name and title the user chose when creating the bot; the focus
  // step only suggests apps, it must not rename the bot.
  await post(
    deps,
    target,
    [
      {
        kind: "text",
        text: `Got it. ${capitalize(option.summary)}. I’ll see what’s already connected so I don’t make you set something up twice.`,
      },
    ],
    false,
  );

  const providers = deps.connectors.managedProviders();
  const catalog = (
    await Promise.all(
      providers.map((provider) =>
        provider
          .catalog({
            operationId: "onboarding.choose",
            traceId: "onboarding.choose",
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: bot.id,
            signal: AbortSignal.timeout(15_000),
          })
          .catch(() => []),
      ),
    )
  ).flat();
  const cards: MessageBlock[] = option.apps.flatMap((slug) => {
    const entry = matchAppCatalog(catalog, slug);
    return entry ? [appConnectCard(entry)] : [];
  });
  if (!cards.length) {
    await post(deps, target, [{ kind: "text", text: "What would you like to work on first?" }]);
    return;
  }
  const cardNames = cards
    .map((card) => (card.kind === "app_connect" ? card.name : ""))
    .filter(Boolean);
  const named = `${cardNames.slice(0, -1).join(", ")}${cardNames.length > 1 ? ", and " : ""}${cardNames.at(-1)}`;
  await post(deps, target, [
    {
      kind: "text",
      text: `${named} are a good place to start. Connect them here and I’ll use what you already have.`,
    },
  ]);
  await post(deps, target, cards);
  await post(deps, target, [
    {
      kind: "text",
      text: `Hit those ${cards.length === 1 ? "one" : cards.length === 2 ? "two" : "three"} and I’ll start pulling the picture.`,
    },
  ]);
}

export async function markAppConnected(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  provider: string,
  connectorId = "composio",
  threadId?: string,
  messageId?: string,
): Promise<void> {
  const { bot, thread: ownThread } = await requireBotThread(deps, actor, botId);
  let thread = ownThread;
  if (threadId && threadId !== ownThread.id) {
    const candidate = await deps.prisma.thread.findFirst({
      where: { id: threadId, spaceId: actor.spaceId },
    });
    if (!candidate?.groupId) throw new IsolationError();
    const target = await resolveThreadTarget(deps.prisma, actor, { groupId: candidate.groupId });
    if (target.kind !== "group" || !target.memberBotIds.includes(botId)) throw new IsolationError();
    thread = { ...ownThread, id: target.threadId };
  }
  const providerAdapter = deps.connectors.managed(connectorId);
  if (!providerAdapter) return;
  const catalog = await providerAdapter.catalog(
    {
      operationId: "onboarding.appConnected",
      traceId: "onboarding.appConnected",
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId,
      signal: AbortSignal.timeout(15_000),
    },
    provider,
  );
  const entry = matchAppCatalog(
    catalog.filter((item) => item.connectorId === connectorId),
    provider,
  );
  if (!entry?.connected) return;
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const updates = await deps.prisma.$transaction(async (tx) => {
    // Two authorizations may finish together on an onboarding message with multiple cards.
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    // Onboarding cards sit at the start of the chat and inline cards near the end;
    // bound both reads so a long chat is never scanned in full.
    const select = { id: true, blocks: true } as const;
    const first = await tx.message.findMany({
      where: { threadId: thread.id },
      select,
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    const latest = await tx.message.findMany({
      where: { threadId: thread.id },
      select,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const own = messageId
      ? await tx.message.findMany({ where: { id: messageId, threadId: thread.id }, select })
      : [];
    const messages = [...new Map([...first, ...latest, ...own].map((m) => [m.id, m])).values()];
    const events = [];
    for (const message of messages) {
      const blocks = message.blocks as MessageBlock[];
      if (
        !blocks.some(
          (block) =>
            matchesAppConnection(block, connectorId, entry.slug) && block.status !== "connected",
        )
      )
        continue;
      const next = connectedAppBlocks(blocks, connectorId, entry.slug).map((block) =>
        isL0aBlock(block) &&
        block.kind === "app_connect" &&
        block.status === "connected" &&
        block.interactionId
          ? stampL0aBlock(block, {
              interactionId: block.interactionId,
              cardStatus: "succeeded",
            })
          : block,
      );
      await tx.message.update({ where: { id: message.id }, data: { blocks: next } });
      for (const block of next) {
        if (
          isL0aBlock(block) &&
          block.kind === "app_connect" &&
          block.status === "connected" &&
          block.interactionId
        ) {
          await settleInteraction(tx as never, {
            interactionId: block.interactionId,
            status: "succeeded",
            reason: "app connected",
          });
        }
      }
      events.push(
        await appendEventInTransaction(tx, {
          ...target,
          type: "thread.message.updated",
          payload: { messageId: message.id, role: "bot", blocks: next },
        }),
      );
    }
    return events;
  });
  for (const event of updates) await deps.events.notify(thread.id, event.seq);
  // The card flipping to connected is only half the job: a chat that paused for
  // this app needs its surface back, or the bot never asks for the next fields.
  await resumeInteractionAfterConnection(
    { prisma: deps.prisma, jobs: deps.jobs },
    {
      actor: { spaceId: actor.spaceId, userId: actor.userId },
      botId: bot.id,
      threadId: thread.id,
      provider: entry.slug,
      appConnected: entry.connected,
    },
  ).catch((error) => {
    getLogger().error("interaction resume after app connect", error);
  });
}

function capitalize(value: string): string {
  return value.length > 0 ? (value[0] ?? "").toUpperCase() + value.slice(1) : value;
}
