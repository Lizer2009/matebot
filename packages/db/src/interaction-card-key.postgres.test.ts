import { interactionCardKey } from "@matebot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createInteraction } from "./interactions.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const OPEN = ["collecting", "ready_for_review", "awaiting_approval"] as const;

describePostgres("interaction card key (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `card-key-org-${suffix}`;
  const userId = `card-key-user-${suffix}`;
  const botId = `card-key-bot-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let spaceId: string;
  let threadId: string;

  const plan = {
    intent: "email.compose",
    title: "T",
    fields: [],
    nextStep: "render" as const,
    riskLevel: "low" as const,
  };

  const insert = (cardKey: string, status: string) =>
    prisma.interaction.create({
      data: {
        spaceId,
        threadId,
        intent: "email.compose",
        status,
        cardKey,
        plan,
      },
    });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await prisma.interaction.deleteMany({ where: { threadId } });
      await prisma.thread.deleteMany({ where: { id: threadId } });
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.$disconnect();
      await db.pool.end();
    };
    spaceId = `card-key-space-${suffix}`;
    threadId = `card-key-thread-${suffix}`;
    await prisma.organization.create({
      data: { id: organizationId, name: "Acme", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Support" } });
    // A thread must be owned by exactly one of a bot, a group or an external conversation.
    await prisma.bot.create({
      data: { id: botId, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
  });

  afterAll(async () => {
    if (close) await close();
  });

  it("keeps the partial unique index the spec depends on", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'interactions'
        AND indexname = 'interactions_one_open_card_per_intent'
    `;
    expect(rows).toHaveLength(1);
  });

  it("refuses a second open card with the same key", async () => {
    const key = interactionCardKey(threadId, `dup-${suffix}`);
    await insert(key, "collecting");
    await expect(insert(key, "ready_for_review")).rejects.toMatchObject({ code: "P2002" });
  });

  // The index is partial: a terminal row must not block a new open one, or every
  // executed card would freeze its intent for that thread forever.
  it("allows a new open card once the previous one is terminal", async () => {
    const key = interactionCardKey(threadId, `reopen-${suffix}`);
    const first = await insert(key, "collecting");
    await prisma.interaction.update({ where: { id: first.id }, data: { status: "superseded" } });
    await expect(insert(key, "collecting")).resolves.toMatchObject({ cardKey: key });
  });

  it("does not constrain connections, which are exempt from settlement", async () => {
    const key = interactionCardKey(threadId, `conn-${suffix}`);
    await insert(key, "needs_connection");
    await expect(insert(key, "needs_connection")).resolves.toBeTruthy();
  });

  it("stamps cardKey on every open status", async () => {
    for (const status of OPEN) {
      const key = interactionCardKey(threadId, `stamp-${status}-${suffix}`);
      const row = await insert(key, status);
      expect(row.cardKey).toBe(key);
    }
  });

  // The helper is what makes the column's nullability a rollout window rather than a hole:
  // a caller that knows only thread and intent still produces a row the index covers.
  it("derives the card key when the caller does not pass one", async () => {
    const row = await createInteraction(prisma, {
      spaceId,
      threadId,
      intent: "email.compose",
      status: "collecting",
      plan,
    });
    const key = interactionCardKey(threadId, "email.compose");
    expect(row.cardKey).toBe(key);
    await expect(prisma.interaction.count({ where: { threadId, cardKey: key } })).resolves.toBe(1);
  });
});
