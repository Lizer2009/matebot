import { randomUUID } from "node:crypto";
import type { InteractionPlan } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb } from "@matebot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { publishOrAmend } from "./interaction-publish.js";
import { gcStaleCards, markOpenCardsStale, settleStaleCards } from "./interaction-stale.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

const EMAIL_PLAN: InteractionPlan = {
  intent: "email.compose",
  title: "冬天的问候",
  fields: [
    { name: "to", value: "alex@example.test", required: true, status: "resolved" },
    { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
    { name: "body", value: "正文", required: true, status: "resolved" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

function surfaceBlock(blocks: unknown): { status?: string; stale?: boolean; template?: string } {
  if (!Array.isArray(blocks)) return {};
  const block = blocks.find((entry) => (entry as { kind?: string }).kind === "a2ui_surface") as
    | { status?: string; stale?: boolean; template?: string }
    | undefined;
  return block ?? {};
}

describePostgres("two-stage stale settle (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let threadId: string;
  let botId: string;
  const mark = new Date("2026-11-14T00:00:00.000Z");

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const organization = await system.organization.create({
      data: {
        id: `org-${stamp}`,
        name: `org-${stamp}`,
        slug: `org-${stamp}`,
        createdAt: new Date(),
      },
    });
    const space = await system.space.create({
      data: { id: `space-${stamp}`, organizationId: organization.id, name: "space" },
    });
    spaceId = space.id;
    botId = `bot-${stamp}`;
    await system.bot.create({
      data: { id: botId, spaceId, userId: `user-${stamp}`, name: "Matebot", color: "#3b82f6" },
    });
    const thread = await system.thread.create({
      data: { id: `thread-${stamp}`, spaceId, userId: `user-${stamp}`, botId },
    });
    threadId = thread.id;
  });

  afterAll(async () => {
    if (db) {
      await system.interaction.deleteMany({ where: { threadId } });
      await system.thread.deleteMany({ where: { id: threadId } });
      await system.organization.deleteMany({ where: { id: `org-${stamp}` } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  beforeEach(async () => {
    if (!threadId) return;
    await system.interaction.deleteMany({ where: { threadId } });
    await system.message.deleteMany({ where: { threadId } });
  });

  it("marks an open card stale without closing it, then settles the matching snapshot", async () => {
    const published = await publishOrAmend(system, {
      spaceId,
      threadId,
      botId,
      plan: EMAIL_PLAN,
    });
    const marked = await markOpenCardsStale(system, { threadId, at: mark });
    expect(marked.marked).toEqual([published.interactionId]);

    const afterMark = await system.interaction.findUnique({
      where: { id: published.interactionId },
    });
    expect(afterMark?.status).not.toBe("superseded");
    expect(afterMark?.staleAt?.getTime()).toBe(mark.getTime());
    const markedMessage = await system.message.findUnique({ where: { id: published.messageId } });
    expect(surfaceBlock(markedMessage?.blocks)).toMatchObject({
      status: afterMark?.status,
      stale: true,
    });

    const settled = await settleStaleCards(system, {
      threadId,
      staleAtSnapshot: mark,
      reason: "user_message",
    });
    expect(settled.settled).toEqual([published.interactionId]);
    const afterSettle = await system.interaction.findUnique({
      where: { id: published.interactionId },
    });
    expect(afterSettle).toMatchObject({ status: "superseded", staleAt: null });
    const settledMessage = await system.message.findUnique({ where: { id: published.messageId } });
    expect(surfaceBlock(settledMessage?.blocks)).toMatchObject({
      status: "superseded",
      template: "action-superseded-card",
    });
    expect(surfaceBlock(settledMessage?.blocks).stale).toBeUndefined();
  });

  it("does not settle a card whose mark was replaced by a later snapshot", async () => {
    const published = await publishOrAmend(system, {
      spaceId,
      threadId,
      botId,
      plan: EMAIL_PLAN,
    });
    await markOpenCardsStale(system, { threadId, at: mark });
    const later = new Date("2026-11-14T00:01:00.000Z");
    await markOpenCardsStale(system, { threadId, at: later });

    expect(
      await settleStaleCards(system, {
        threadId,
        staleAtSnapshot: mark,
        reason: "user_message",
      }),
    ).toEqual({ settled: [] });
    const row = await system.interaction.findUnique({ where: { id: published.interactionId } });
    expect(row?.status).not.toBe("superseded");
    expect(row?.staleAt?.getTime()).toBe(later.getTime());
  });

  it("does not mark needs_connection, and GCs leftover marks older than this run", async () => {
    const published = await publishOrAmend(system, {
      spaceId,
      threadId,
      botId,
      plan: EMAIL_PLAN,
      status: "needs_connection",
    });
    expect(await markOpenCardsStale(system, { threadId, at: mark })).toEqual({ marked: [] });
    const waiting = await system.interaction.findUnique({ where: { id: published.interactionId } });
    expect(waiting).toMatchObject({ status: "needs_connection", staleAt: null });

    const leftover = await publishOrAmend(system, {
      spaceId,
      threadId,
      botId,
      plan: { ...EMAIL_PLAN, intent: "calendar.create" },
    });
    await markOpenCardsStale(system, { threadId, at: mark });
    const runStart = new Date("2026-11-14T00:05:00.000Z");
    expect(await gcStaleCards(system, { threadId, before: runStart })).toEqual({
      settled: [leftover.interactionId],
    });
    expect(
      (await system.interaction.findUnique({ where: { id: leftover.interactionId } }))?.status,
    ).toBe("superseded");
    expect(
      (await system.interaction.findUnique({ where: { id: published.interactionId } }))?.status,
    ).toBe("needs_connection");
  });

  it("refuses an old stale snapshot after confirm cleared staleAt (AC-8c)", async () => {
    const published = await publishOrAmend(system, {
      spaceId,
      threadId,
      botId,
      plan: EMAIL_PLAN,
    });
    await markOpenCardsStale(system, { threadId, at: mark });
    const confirmed = await system.interaction.updateMany({
      where: { id: published.interactionId, draftVersion: published.draftVersion },
      data: {
        staleAt: null,
        confirmedVersion: published.draftVersion,
        status: "awaiting_approval",
      },
    });
    expect(confirmed.count).toBe(1);
    expect(
      await settleStaleCards(system, {
        threadId,
        staleAtSnapshot: mark,
        reason: "user_message",
      }),
    ).toEqual({ settled: [] });
    const row = await system.interaction.findUnique({ where: { id: published.interactionId } });
    expect(row).toMatchObject({ status: "awaiting_approval", staleAt: null });
  });
});
