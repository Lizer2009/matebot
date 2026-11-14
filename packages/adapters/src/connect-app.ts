import type { AdapterContext, ManagedConnectorProvider } from "@matebot/adapter-kit";
import type { MessageBlock } from "@matebot/contracts";
import {
  appConnectCard,
  interactionResumesWhenConnected,
  l0aIntentForBlock,
  matchAppCatalog,
  matchesAppConnection,
} from "@matebot/core";
import type { PrismaClient, ThreadEvents } from "@matebot/db";
import { publishL0aView } from "./interaction-l0a-publish.js";
import { annotateAppCatalog, annotateAppConnected } from "./route-annotation.js";

const RECENT_MESSAGES = 50;

const ALREADY_SHOWN =
  "Connection card already shown. Wait for the user to connect the app. The app is not connected yet and nothing has run.";
const CARD_SHOWN =
  "Connection card shown. Wait for the user to connect the app. The app is not connected yet and nothing has run.";

async function openConnectionDemand(
  prisma: PrismaClient,
  input: { threadId: string; provider: string; intent: string },
) {
  const row = await prisma.interaction.findFirst({
    where: { threadId: input.threadId, status: "needs_connection" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, intent: true, status: true },
  });
  if (!row) return undefined;
  if (row.intent === input.intent || row.intent.startsWith(`${input.intent}.`)) return row;
  if (
    interactionResumesWhenConnected({
      intent: row.intent,
      interactionStatus: row.status,
      provider: input.provider,
    })
  ) {
    return row;
  }
  return undefined;
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
  const intent = l0aIntentForBlock(block);
  const existingDemand = await openConnectionDemand(deps.prisma, {
    threadId: target.threadId,
    provider: entry.slug,
    intent,
  });
  if (existingDemand) {
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
  const published = await publishL0aView(deps.prisma, {
    spaceId: target.spaceId,
    threadId: target.threadId,
    botId: target.botId,
    runId: target.id,
    intent,
    title: `Connect ${entry.name}`,
    status: "needs_connection",
    block,
    clientNonce: skipPost.nonce,
  });
  await deps.events.notify(
    target.threadId,
    published.eventSeq,
    published.amended ? undefined : target.id,
  );
  return {
    status: "pending",
    // A catalog card the person has not authorized yet. It is shown, not connected, and it has
    // run nothing — three different things that must not be conflated in what the model reads.
    ...annotateAppCatalog(),
    message: published.amended ? ALREADY_SHOWN : CARD_SHOWN,
  };
}
