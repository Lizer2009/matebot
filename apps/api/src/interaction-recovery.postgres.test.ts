import { randomUUID } from "node:crypto";
import type { InteractionPlan } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb, getInteraction } from "@matebot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    // The event row is not what this suite is about, and appending one needs a run to hang it
    // from. The card rewrite below is the real write under test.
    appendEventInTransaction: vi.fn(async () => ({ id: "event", seq: 1 })),
  };
});

import { resumeInteractionAfterConnection } from "./interaction-resume.js";

/**
 * The recovery loop, on a real database: a card that waited for a mailbox, then the mailbox
 * connects.
 *
 * The unit tests around `resumeInteractionAfterConnection` mock the transaction, so they can
 * only show that the right calls were made. What has to be true — and what nobody could see
 * before this file — is that the row on disk, the block on the message and the person's own
 * edits all survive the recovery, and that the recovered card still waits for its own
 * confirmation rather than sending anything.
 */

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

const plan = (fields: InteractionPlan["fields"]): InteractionPlan => ({
  intent: "email.compose",
  title: "冬天的问候",
  fields,
  nextStep: "render",
  riskLevel: "medium",
});

describePostgres("connection recovery (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let threadId: string;
  let userId: string;
  let botId: string;
  let messageId: string;
  let interactionId: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    userId = `user-${stamp}`;
    spaceId = `space-${stamp}`;
    threadId = `thread-${stamp}`;
    botId = `bot-${stamp}`;
    messageId = `msg-${stamp}`;
    interactionId = `ix-${stamp}`;

    await system.organization.create({
      data: {
        id: `org-${stamp}`,
        name: `org-${stamp}`,
        slug: `org-${stamp}`,
        createdAt: new Date(),
      },
    });
    await system.space.create({
      data: { id: spaceId, organizationId: `org-${stamp}`, name: "space" },
    });
    await system.bot.create({
      data: { id: botId, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    await system.thread.create({ data: { id: threadId, spaceId, userId, botId } });
    // The card as it was left: waiting for a mailbox, with the person's own subject already
    // typed. The values are what must not move when the status does.
    await system.message.create({
      data: {
        id: messageId,
        threadId,
        seq: 0,
        role: "bot",
        botId,
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId,
            surfaceId: `surface-${stamp}`,
            protocolFamily: "v0_9",
            draftVersion: 1,
            intent: "email.compose",
            capability: "not_connected",
            template: "email-connection-card",
            lifecycle: "draft",
          },
        ] as never,
      },
    });
    await system.interaction.create({
      data: {
        id: interactionId,
        spaceId,
        threadId,
        messageId,
        intent: "email.compose",
        status: "needs_connection",
        draftVersion: 1,
        plan: plan([
          { name: "to", value: "alex@example.test", required: true, status: "resolved" },
          { name: "subject", value: "我写的主题", required: true, status: "resolved" },
          { name: "body", required: true, status: "missing" },
        ]) as never,
        slots: { to: "alex@example.test", subject: "我写的主题" } as never,
      },
    });
    await system.interactionSurface.create({
      data: {
        interactionId,
        surfaceId: `surface-${stamp}`,
        protocolFamily: "v0_9",
        document: [] as never,
        draftVersion: 1,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await system.message.deleteMany({ where: { threadId } });
    await system.interaction.deleteMany({ where: { threadId } });
    await system.thread.deleteMany({ where: { id: threadId } });
    await system.organization.deleteMany({ where: { id: `org-${stamp}` } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("turns the same card back into an editable draft and changes nothing else", async () => {
    const result = await resumeInteractionAfterConnection(
      { prisma: system },
      {
        actor: { spaceId, userId },
        botId,
        threadId,
        provider: "gmail",
        appConnected: true,
      },
    );
    // The card was refreshed in place, so no model turn was started behind it.
    expect(result).toEqual({ refreshedInteractionIds: [interactionId], queuedRunId: null });

    const row = await getInteraction(system, interactionId);
    if (!row) throw new Error("interaction missing");
    expect(row.status).toBe("collecting");
    expect(row.draftVersion).toBe(1);
    // The person's typing and the missing body are exactly as they were. Recovery is not edit.
    expect(row.slots).toMatchObject({ to: "alex@example.test", subject: "我写的主题" });
    expect((row.slots as Record<string, unknown>).body).toBeUndefined();
    expect(row.confirmedVersion).toBeNull();

    const message = await system.message.findUnique({ where: { id: messageId } });
    const block = (message?.blocks as Array<Record<string, unknown>>)[0];
    expect(block).toMatchObject({ capability: "ready", template: "email-draft-card" });
    // Nothing was sent and nothing was confirmed by the recovery itself.
    expect(block?.lifecycle).toBe("draft");
  });

  it("does not start a model turn when the thread's card waits on another app", async () => {
    const otherThread = `thread-other-${stamp}`;
    const otherBot = `bot-other-${stamp}`;
    await system.bot.create({
      data: { id: otherBot, spaceId, userId, name: "Matebot 2", color: "#3b82f6" },
    });
    await system.thread.create({
      data: { id: otherThread, spaceId, userId, botId: otherBot },
    });
    const calendarId = `ix-cal-${stamp}`;
    await system.interaction.create({
      data: {
        id: calendarId,
        spaceId,
        threadId: otherThread,
        intent: "calendar.create",
        status: "needs_connection",
        draftVersion: 1,
        plan: {
          intent: "calendar.create",
          title: "Create calendar",
          fields: [{ name: "name", required: true, status: "missing" }],
          nextStep: "ask",
          riskLevel: "medium",
        } as never,
      },
    });

    const result = await resumeInteractionAfterConnection(
      { prisma: system },
      {
        actor: { spaceId, userId },
        botId: otherBot,
        threadId: otherThread,
        provider: "gmail",
        appConnected: true,
      },
    );
    // The mailbox is not what that card waits for, and the chat is not idle: asking for an
    // email draft here would compete with the calendar card still on screen.
    expect(result).toEqual({ refreshedInteractionIds: [], queuedRunId: null });

    await system.interaction.deleteMany({ where: { id: calendarId } });
    await system.thread.deleteMany({ where: { id: otherThread } });
    await system.bot.deleteMany({ where: { id: otherBot } });
  });
});
