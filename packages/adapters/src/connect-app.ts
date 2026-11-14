import type { AdapterContext, ManagedConnectorProvider } from "@matebot/adapter-kit";
import type { MessageBlock } from "@matebot/contracts";
import {
  appConnectCard,
  featuredConnectorProvidersMatch,
  l0aIntentForBlock,
  matchAppCatalog,
  matchesAppConnection,
  pickMatchingConnectionCard,
} from "@matebot/core";
import type { PrismaClient, ThreadEvents } from "@matebot/db";
import { findWaitingConnectionCards } from "./interaction-kernel-store.js";
import { publishL0aView } from "./interaction-l0a-publish.js";
import { annotateAppCatalog, annotateAppConnected } from "./route-annotation.js";

const RECENT_MESSAGES = 50;

const ALREADY_SHOWN =
  "Connection card already shown. Wait for the user to connect the app. The app is not connected yet and nothing has run.";
const CARD_SHOWN =
  "Connection card shown. Wait for the user to connect the app. The app is not connected yet and nothing has run.";

async function openConnectionDemand(
  prisma: PrismaClient,
  input: { threadId: string; provider: string; intent: string; accountId?: string },
) {
  const rows = await findWaitingConnectionCards(prisma, input.threadId);
  return pickMatchingConnectionCard(rows, {
    provider: input.provider,
    intent: input.intent,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
}

/** Catalog data is the only source of card content; serialize dedupe with the message write. */
export async function connectApp(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  providers: ManagedConnectorProvider[],
  context: AdapterContext,
  target: { id: string; spaceId: string; threadId: string; botId: string },
  app: unknown,
  effectId: string,
) {
  if (typeof app !== "string" || !app.trim() || app.length > 100) {
    return { error: "Provide an app name or slug of at most 100 characters." };
  }
  const catalog = (
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const query = await provider.catalog(context, app.trim());
          // A provider's text search may not recognize a featured alias such as gcal.
          const entries = matchAppCatalog(query, app) ? query : await provider.catalog(context);
          return entries.filter((entry) => entry.connectorId === provider.describe().id);
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  // An app connected through any provider counts, even if another provider lists it first.
  const entry =
    matchAppCatalog(
      catalog.filter((item) => item.connected),
      app,
    ) ?? matchAppCatalog(catalog, app);
  if (!entry) return { error: "No such app is available in the connector catalog." };
  if (entry.connected)
    return {
      status: "connected",
      // A connected app is still only L2/L3: the connection exists, nothing has run. Saying
      // "connected" without that distinction is what let an earlier turn report a connection as
      // though work had been done.
      ...annotateAppConnected(),
      message:
        "This app is already connected and its tools are available. Nothing has been run: no action has happened yet.",
    };
  const block = appConnectCard(entry);
  const accountIds = await namedReconnectAccountIds(deps.prisma, {
    spaceId: context.spaceId,
    userId: context.userId,
    provider: entry.slug,
  });
  const namedIntents: Array<{ intent: string; accountId?: string }> =
    accountIds.length > 0
      ? accountIds.map((accountId) => ({
          accountId,
          intent: l0aIntentForBlock(block, { accountId }),
        }))
      : [{ intent: l0aIntentForBlock(block) }];
  const pending = [];
  for (const named of namedIntents) {
    const existingDemand = await openConnectionDemand(deps.prisma, {
      threadId: target.threadId,
      provider: entry.slug,
      intent: named.intent,
      ...(named.accountId ? { accountId: named.accountId } : {}),
    });
    if (!existingDemand) pending.push(named);
  }
  if (pending.length === 0) {
    return {
      status: "pending",
      ...annotateAppCatalog(),
      message: ALREADY_SHOWN,
    };
  }
  const skipPost = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const nonce = `connect-app:${effectId}`;
    const replayed = await tx.message.findFirst({
      where: { threadId: target.threadId, clientNonce: nonce },
      select: { id: true },
    });
    if (replayed) return { skip: true as const, nonce };
    // Only recent cards count as already shown; an old one far up the chat should not block a new one.
    const recent = await tx.message.findMany({
      where: { threadId: target.threadId },
      select: { blocks: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_MESSAGES,
    });
    if (
      recent.some((message) =>
        (message.blocks as MessageBlock[]).some(
          (candidate) =>
            matchesAppConnection(candidate, entry.connectorId, entry.slug) &&
            candidate.status === "pending",
        ),
      )
    ) {
      return { skip: true as const, nonce };
    }
    return { skip: false as const, nonce };
  });
  if (skipPost.skip) {
    return {
      status: "pending",
      ...annotateAppCatalog(),
      message: ALREADY_SHOWN,
    };
  }
  let last = {
    eventSeq: 0,
    amended: false,
  };
  for (const [index, named] of pending.entries()) {
    const published = await publishL0aView(deps.prisma, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.id,
      intent: named.intent,
      title: `Connect ${entry.name}`,
      status: "needs_connection",
      block,
      clientNonce: index === 0 ? skipPost.nonce : `${skipPost.nonce}:${named.intent}`,
    });
    last = published;
  }
  await deps.events.notify(target.threadId, last.eventSeq, last.amended ? undefined : target.id);
  return {
    status: "pending",
    // A catalog card the person has not authorized yet. It is shown, not connected, and it has
    // run nothing — three different things that must not be conflated in what the model reads.
    ...annotateAppCatalog(),
    message: last.amended ? ALREADY_SHOWN : CARD_SHOWN,
  };
}

async function namedReconnectAccountIds(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; provider: string },
): Promise<string[]> {
  if (typeof prisma.connection?.findMany !== "function") return [];
  const rows = await prisma.connection.findMany({
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      status: { in: ["error", "pending"] },
    },
    select: { provider: true, providerRef: true },
  });
  const ids: string[] = [];
  for (const row of rows) {
    const ref = row.providerRef?.trim();
    if (!ref) continue;
    if (
      row.provider.toLowerCase() !== input.provider.toLowerCase() &&
      !featuredConnectorProvidersMatch(row.provider, input.provider)
    ) {
      continue;
    }
    if (ref.toLowerCase() === input.provider.toLowerCase()) continue;
    ids.push(ref);
  }
  return [...new Set(ids)];
}
