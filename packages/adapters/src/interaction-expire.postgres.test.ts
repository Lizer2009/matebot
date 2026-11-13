import { randomUUID } from "node:crypto";
import type { InteractionPlan } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb } from "@matebot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireDueInteractions } from "./interaction-expire.js";
import { publishOrAmend } from "./interaction-publish.js";

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

describePostgres("expireDueInteractions (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let threadId: string;
  let userId: string;
  let botId: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    userId = `user-${stamp}`;
    botId = `bot-${stamp}`;
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
    await system.bot.create({
      data: { id: botId, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    const thread = await system.thread.create({
      data: { id: `thread-${stamp}`, spaceId, userId, botId },
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

  it("expires an overdue approval card and restamps the message block", async () => {
    const published = await publishOrAmend(system, {
      spaceId,
      threadId,
      botId,
      plan: EMAIL_PLAN,
    });
    await system.interaction.update({
      where: { id: published.interactionId },
      data: { status: "awaiting_approval", expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await expireDueInteractions(system, { interactionId: published.interactionId });
    expect(result.expired).toEqual([published.interactionId]);

    const row = await system.interaction.findUnique({ where: { id: published.interactionId } });
    expect(row?.status).toBe("expired");
    const message = await system.message.findUnique({ where: { id: published.messageId } });
    const block = Array.isArray(message?.blocks)
      ? (message.blocks as Array<{ kind?: string; status?: string; template?: string }>).find(
          (entry) => entry.kind === "a2ui_surface",
        )
      : undefined;
    expect(block).toMatchObject({ status: "expired", template: "action-expired-card" });
    expect(
      await system.interactionEvent.count({
        where: { interactionId: published.interactionId, kind: "settled" },
      }),
    ).toBeGreaterThan(0);
  });

  it("does not expire unknown even with a past expiresAt", async () => {
    const published = await publishOrAmend(system, {
      spaceId,
      threadId,
      botId,
      plan: EMAIL_PLAN,
    });
    await system.interaction.update({
      where: { id: published.interactionId },
      data: { status: "unknown", expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await expireDueInteractions(system, { interactionId: published.interactionId })).toEqual(
      { expired: [] },
    );
    const row = await system.interaction.findUnique({ where: { id: published.interactionId } });
    expect(row?.status).toBe("unknown");
  });
});
