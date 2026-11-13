import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishOrAmend, settleInteraction } from "@matebot/adapters";
import type { InteractionPlan, MessageBlock } from "@matebot/contracts";
import { surfaceStampFor } from "@matebot/core";
import { interactionCardKey } from "@matebot/core/node/interaction-card-key";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb, InteractionNotFoundError, runAsSystem } from "@matebot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discardBotIntroRun } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";
import { InteractionRetryRejectedError, retryInteractionService } from "./interaction-retry.js";

/**
 * Retry on a migrated database: the same row, the same message, a restamped
 * surface. Mocks cannot prove the partial unique index or the CAS write.
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

function surfaceBlock(blocks: unknown): MessageBlock | undefined {
  if (!Array.isArray(blocks)) return undefined;
  return blocks.find((entry) => (entry as { kind?: string }).kind === "a2ui_surface") as
    | MessageBlock
    | undefined;
}

describePostgres("retryInteractionService (PostgreSQL)", () => {
  const stamp = randomUUID();
  const P = `retry-${stamp}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let threadId: string;
  let botId: string;
  let userId: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    process.env.FEATURE_A2UI = "1";
    userId = `${P}-user`;
    botId = `${P}-bot`;
    const organization = await system.organization.create({
      data: {
        id: `${P}-org`,
        name: `${P}-org`,
        slug: `${P}-org`,
        createdAt: new Date(),
      },
    });
    const space = await system.space.create({
      data: { id: `${P}-space`, organizationId: organization.id, name: "space" },
    });
    spaceId = space.id;
    await system.bot.create({
      data: { id: botId, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    const thread = await system.thread.create({
      data: { id: `${P}-thread`, spaceId, userId, botId },
    });
    threadId = thread.id;
  });

  afterAll(async () => {
    if (!db) return;
    await system.interaction.deleteMany({ where: { threadId } });
    await system.message.deleteMany({ where: { threadId } });
    await system.thread.deleteMany({ where: { id: threadId } });
    await system.organization.deleteMany({ where: { id: `${P}-org` } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  beforeEach(async () => {
    await system.interaction.deleteMany({ where: { threadId } });
    await system.message.deleteMany({ where: { threadId } });
  });

  async function publish() {
    return publishOrAmend(system, { spaceId, threadId, botId, plan: EMAIL_PLAN });
  }

  async function expire(interactionId: string) {
    const settled = await settleInteraction(system, {
      interactionId,
      status: "expired",
      reason: "test",
    });
    expect(settled).toMatchObject({ settled: true });
    const message = await system.message.findFirst({ where: { threadId } });
    expect(message).toBeTruthy();
    const existing = Array.isArray(message!.blocks) ? (message!.blocks as MessageBlock[]) : [];
    const stamps = surfaceStampFor({ status: "expired", intent: "email.compose" });
    const blocks = existing.map((entry) =>
      entry.kind === "a2ui_surface" ? { ...entry, ...stamps } : entry,
    );
    await system.message.update({
      where: { id: message!.id },
      data: { blocks: blocks as never },
    });
    return surfaceBlock(blocks);
  }

  it("revives an expired card in place and restamps the same surface", async () => {
    const published = await publish();
    const cardKey = interactionCardKey(threadId, "email.compose");
    const expiredBlock = await expire(published.interactionId);
    expect(expiredBlock).toMatchObject({
      status: "expired",
      template: "action-expired-card",
      interactionId: published.interactionId,
      surfaceId: published.surfaceId,
    });

    const result = await retryInteractionService(system, {
      spaceId,
      threadId,
      botId,
      interactionId: published.interactionId,
    });
    expect(result.interactionId).toBe(published.interactionId);
    expect(result.surfaceId).toBe(published.surfaceId);
    expect(result.draftVersion).toBe(published.draftVersion + 1);
    expect(["collecting", "ready_for_review"]).toContain(result.status);

    const row = await system.interaction.findUnique({ where: { id: published.interactionId } });
    expect(row).toMatchObject({
      cardKey,
      status: result.status,
      draftVersion: result.draftVersion,
      messageId: published.messageId,
    });
    expect(await system.interaction.count({ where: { threadId, cardKey } })).toBe(1);
    expect(await system.message.count({ where: { threadId } })).toBe(1);

    const message = await system.message.findUnique({ where: { id: published.messageId } });
    expect(surfaceBlock(message?.blocks)).toMatchObject({
      kind: "a2ui_surface",
      interactionId: published.interactionId,
      surfaceId: published.surfaceId,
      draftVersion: result.draftVersion,
      status: result.status,
      template: "email-draft-card",
      lifecycle: "draft",
    });
  });

  it("revives a failed card and refuses cancelled and superseded", async () => {
    const failed = await publish();
    await settleInteraction(system, {
      interactionId: failed.interactionId,
      status: "failed",
      reason: "test",
    });
    await expect(
      retryInteractionService(system, {
        spaceId,
        threadId,
        botId,
        interactionId: failed.interactionId,
      }),
    ).resolves.toMatchObject({ interactionId: failed.interactionId });

    const live = await publish();
    await settleInteraction(system, {
      interactionId: live.interactionId,
      status: "cancelled",
      reason: "test",
    });
    await expect(
      retryInteractionService(system, {
        spaceId,
        threadId,
        botId,
        interactionId: live.interactionId,
      }),
    ).rejects.toMatchObject({ name: "InteractionRetryRejectedError", code: "not_revivable" });

    const next = await publish();
    await settleInteraction(system, {
      interactionId: next.interactionId,
      status: "superseded",
      reason: "test",
    });
    await expect(
      retryInteractionService(system, {
        spaceId,
        threadId,
        botId,
        interactionId: next.interactionId,
      }),
    ).rejects.toBeInstanceOf(InteractionRetryRejectedError);
  });

  it("answers a conflict when the row moved and not found when the card is missing or foreign", async () => {
    const published = await publish();
    await settleInteraction(system, {
      interactionId: published.interactionId,
      status: "expired",
      reason: "test",
    });
    const input = {
      spaceId,
      threadId,
      botId,
      interactionId: published.interactionId,
    };
    const realFind = db.prisma.interaction.findUnique.bind(db.prisma.interaction);
    let snapshots = 0;
    // Prisma's findUnique is a thenable client, not a Promise; the wrapper is a test
    // interceptor only. `as never` matches other store intercepts in this tree.
    db.prisma.interaction.findUnique = (async (
      args: Parameters<typeof db.prisma.interaction.findUnique>[0],
    ) => {
      const row = await realFind(args);
      snapshots += 1;
      // getInteraction reads first; reviveCard's snapshot is the CAS input.
      if (snapshots === 2 && row && row.id === published.interactionId) {
        await runAsSystem("cas contention", () =>
          db.prisma.interaction.update({
            where: { id: row.id },
            data: { draftVersion: { increment: 1 } },
          }),
        );
      }
      return row;
    }) as never;
    try {
      await expect(retryInteractionService(system, input)).rejects.toMatchObject({
        name: "InteractionRetryRejectedError",
        code: "concurrent",
      });
    } finally {
      db.prisma.interaction.findUnique = realFind as never;
    }
    expect(await system.message.count({ where: { threadId } })).toBe(1);

    await expect(
      retryInteractionService(system, {
        spaceId,
        threadId,
        botId,
        interactionId: "missing-interaction",
      }),
    ).rejects.toBeInstanceOf(InteractionNotFoundError);

    await expect(
      retryInteractionService(system, {
        spaceId: `${P}-other-space`,
        threadId,
        botId,
        interactionId: published.interactionId,
      }),
    ).rejects.toBeInstanceOf(InteractionNotFoundError);

    await expect(
      retryInteractionService(system, {
        spaceId,
        threadId: `${P}-other-thread`,
        botId,
        interactionId: published.interactionId,
      }),
    ).rejects.toBeInstanceOf(InteractionNotFoundError);
  });
});

describePostgres("retryInteraction RPC (PostgreSQL)", () => {
  const origin = "http://127.0.0.1:5173";
  let dataDir: string;
  let handles: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    process.env.FEATURE_A2UI = "1";
    process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY ??= "test-encryption-key-test-encryption-key";
    dataDir = await mkdtemp(join(tmpdir(), "matebot-retry-rpc-"));
    handles = await createApp({
      databaseUrl: url!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
    });
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("returns the revived card, CONFLICT when it cannot come back, and NOT_FOUND when it is missing", async () => {
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `retry-${Date.now()}@example.test`,
        password: "test-password-123",
        name: "Retry tester",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const created = await handles.app.request("/rpc/bots/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({
        json: {
          name: "Retry fixture",
          title: "",
          description: "",
          instructions: "Keep the card.",
          notifyOnFinish: false,
        },
      }),
    });
    expect(created.status).toBe(200);
    const botId = ((await created.json()) as { json: { id: string } }).json.id;
    await discardBotIntroRun(handles, cookie, botId);

    const system = asSystem(handles.prisma);
    const bot = await system.bot.findUnique({ where: { id: botId } });
    expect(bot?.spaceId).toBeTruthy();
    const thread = await system.thread.findFirst({ where: { botId } });
    expect(thread).toBeTruthy();
    const published = await publishOrAmend(system, {
      spaceId: bot!.spaceId,
      threadId: thread!.id,
      botId,
      plan: EMAIL_PLAN,
    });
    await settleInteraction(system, {
      interactionId: published.interactionId,
      status: "expired",
      reason: "test",
    });

    const retry = (interactionId: string) =>
      handles.app.request("/rpc/threads/retryInteraction", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json: { botId, interactionId } }),
      });

    const revived = await retry(published.interactionId);
    expect(revived.status).toBe(200);
    const body = (await revived.json()) as {
      json: { interactionId: string; surfaceId: string; draftVersion: number; status: string };
    };
    expect(body.json.interactionId).toBe(published.interactionId);
    expect(body.json.surfaceId).toBe(published.surfaceId);
    expect(body.json.draftVersion).toBe(published.draftVersion + 1);
    expect(["collecting", "ready_for_review"]).toContain(body.json.status);
    expect(
      await system.interaction.count({
        where: { threadId: thread!.id, cardKey: interactionCardKey(thread!.id, "email.compose") },
      }),
    ).toBe(1);

    await settleInteraction(system, {
      interactionId: published.interactionId,
      status: "cancelled",
      reason: "test",
    });
    const refused = await retry(published.interactionId);
    expect(refused.status).toBe(409);
    const missing = await retry("missing-interaction");
    expect(missing.status).toBe(404);

    const other = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `retry-other-${Date.now()}@example.test`,
        password: "test-password-123",
        name: "Other tester",
      }),
    });
    expect(other.status).toBeLessThan(400);
    const stolen = await handles.app.request("/rpc/threads/retryInteraction", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookieHeader(other),
        origin,
      },
      body: JSON.stringify({ json: { botId, interactionId: published.interactionId } }),
    });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect(stolen.status).not.toBe(200);
  });
});
