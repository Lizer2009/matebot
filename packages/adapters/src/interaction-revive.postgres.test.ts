import { randomUUID } from "node:crypto";
import type { InteractionPlan } from "@matebot/contracts";
import { interactionCardKey } from "@matebot/core/node/interaction-card-key";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb } from "@matebot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reviveCard, settleInteraction } from "./interaction-kernel-store.js";
import { publishOrAmend } from "./interaction-publish.js";

/**
 * Retry must revive the same row, not mint a second card. Mocked stores cannot prove the
 * partial unique index still holds after the round-trip, so this goes through PostgreSQL
 * when VERIFY_DATABASE is set. Without a database it skips; that skip is not acceptance.
 */

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

describePostgres("reviveCard (PostgreSQL)", () => {
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

  async function publish() {
    return publishOrAmend(system, { spaceId, threadId, botId, plan: EMAIL_PLAN });
  }

  it("revives an expired card in place and does not mint a second one", async () => {
    const published = await publish();
    const cardKey = interactionCardKey(threadId, "email.compose");
    await settleInteraction(system, {
      interactionId: published.interactionId,
      status: "expired",
      reason: "test",
    });

    const revived = await reviveCard(system, { interactionId: published.interactionId });
    expect(revived).toMatchObject({ revived: true });
    if (!revived.revived) throw new Error("expected revive");
    expect(["collecting", "ready_for_review"]).toContain(revived.status);
    expect(revived.draftVersion).toBe(published.draftVersion + 1);

    const again = await publish();
    expect(again.interactionId).toBe(published.interactionId);
    expect(again.amended).toBe(true);
    expect(await system.interaction.count({ where: { threadId, cardKey } })).toBe(1);
    expect(await system.message.count({ where: { threadId } })).toBe(1);
  });

  it("revives a failed card once and refuses a superseded card", async () => {
    const failed = await publish();
    await settleInteraction(system, {
      interactionId: failed.interactionId,
      status: "failed",
      reason: "test",
    });
    await expect(
      reviveCard(system, { interactionId: failed.interactionId }),
    ).resolves.toMatchObject({ revived: true });

    const live = await publish();
    await settleInteraction(system, {
      interactionId: live.interactionId,
      status: "superseded",
      reason: "test",
    });
    await expect(reviveCard(system, { interactionId: live.interactionId })).resolves.toEqual({
      revived: false,
      reason: "not_revivable",
    });
  });
});
