import { randomUUID } from "node:crypto";
import type { InteractionPlan } from "@matebot/contracts";
import { confirmInteractionDraftState, interactionSlotsFromPlan } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb, getInteraction } from "@matebot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelInteractionService,
  updateInteractionFieldService,
} from "./interaction-field-writer.js";
import { publishInteractionSurface } from "./interaction-publish.js";

/**
 * The draft lifecycle against a real PostgreSQL database.
 *
 * Every other test in this package mocks the database, which means none of them can catch a split
 * between what the compiler produced, what was written to the row, and what the confirm gate reads
 * back. That split is exactly the defect this work started from, so the cases here go through the
 * real tables: publish, edit, re-read, confirm, cancel.
 *
 * No provider is called. `publishInteractionSurface` compiles and stores; confirmation is the gate
 * function, not the sender.
 */

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

const EMAIL_PLAN = (fields: InteractionPlan["fields"]): InteractionPlan => ({
  intent: "email.compose",
  title: "冬天的问候",
  fields,
  nextStep: "render",
  riskLevel: "medium",
});

describePostgres("draft lifecycle (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let threadId: string;
  let userId: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    userId = `user-${stamp}`;
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
    // A thread must be owned by exactly one of a bot, a group or an external conversation.
    const bot = await system.bot.create({
      data: { id: `bot-${stamp}`, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    const thread = await system.thread.create({
      data: { id: `thread-${stamp}`, spaceId, userId, botId: bot.id },
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

  async function publish(fields: InteractionPlan["fields"]) {
    return publishInteractionSurface(system, {
      spaceId,
      threadId,
      botId: `bot-${stamp}`,
      plan: EMAIL_PLAN(fields),
    });
  }

  it("stores the schema's field names and the values the gate will read", async () => {
    const published = await publish([
      { name: "To", value: "alex@example.test", required: true, status: "resolved" },
      { name: "Subject", value: "冬天的问候", required: true, status: "resolved" },
      { name: "Body", value: "正文", required: true, status: "resolved" },
    ]);
    const row = await getInteraction(system, published.interactionId);
    if (!row) throw new Error("interaction missing");
    const plan = row.plan as InteractionPlan;
    const slots = row.slots as Record<string, unknown>;

    expect(plan.fields.map((field) => field.name)).toEqual(["to", "cc", "subject", "body"]);
    expect(slots).toMatchObject({ to: "alex@example.test", subject: "冬天的问候", body: "正文" });
    // The gate reads the row, not the plan that was submitted.
    expect(
      confirmInteractionDraftState(
        {
          status: row.status as never,
          draftVersion: row.draftVersion,
          confirmedVersion: row.confirmedVersion,
          plan,
          slots,
        },
        row.draftVersion,
      ),
    ).toMatchObject({ ok: true });
  });

  it("persists an edit, bumps the version and keeps the person's value", async () => {
    const published = await publish([
      { name: "to", value: "a@example.test", required: true, status: "resolved" },
      { name: "subject", value: "旧主题", required: true, status: "resolved" },
      { name: "body", value: "正文", required: true, status: "resolved" },
    ]);

    await updateInteractionFieldService(system, {
      spaceId,
      threadId,
      botId: `bot-${stamp}`,
      interactionId: published.interactionId,
      expectedDraftVersion: 1,
      name: "subject",
      value: "我写的主题",
      origin: "user",
    });

    const row = await getInteraction(system, published.interactionId);
    if (!row) throw new Error("interaction missing");
    const plan = row.plan as InteractionPlan;
    const slots = row.slots as Record<string, unknown>;
    expect(row.draftVersion).toBe(2);
    expect(slots.subject).toBe("我写的主题");
    // The author is on the row, which is what a later model edit consults.
    expect(plan.fields.find((field) => field.name === "subject")?.source).toBe("user");
    // Republishing keeps the schema's names rather than the model's original spellings.
    expect(plan.fields.map((field) => field.name)).toEqual(["to", "cc", "subject", "body"]);
  });

  it("refuses a confirmation against the version from before an edit", async () => {
    const published = await publish([
      { name: "to", value: "a@example.test", required: true, status: "resolved" },
      { name: "subject", value: "旧主题", required: true, status: "resolved" },
      { name: "body", value: "正文", required: true, status: "resolved" },
    ]);
    await updateInteractionFieldService(system, {
      spaceId,
      threadId,
      botId: `bot-${stamp}`,
      interactionId: published.interactionId,
      expectedDraftVersion: 1,
      name: "subject",
      value: "新主题",
      origin: "user",
    });

    const row = await getInteraction(system, published.interactionId);
    if (!row) throw new Error("interaction missing");
    const stale = confirmInteractionDraftState(
      {
        status: row.status as never,
        draftVersion: row.draftVersion,
        confirmedVersion: row.confirmedVersion,
        plan: row.plan as InteractionPlan,
        slots: row.slots as Record<string, unknown>,
      },
      1,
    );
    expect(stale).toMatchObject({ ok: false, error: "version_conflict" });
  });

  it("refuses a confirmation once the draft is cancelled on disk", async () => {
    const published = await publish([
      { name: "to", value: "a@example.test", required: true, status: "resolved" },
      { name: "subject", value: "s", required: true, status: "resolved" },
      { name: "body", value: "b", required: true, status: "resolved" },
    ]);
    const cancelled = await cancelInteractionService(system, {
      spaceId,
      threadId,
      botId: `bot-${stamp}`,
      interactionId: published.interactionId,
      expectedDraftVersion: 1,
      runtimeCanAbort: false,
    });
    expect(cancelled).toMatchObject({ status: "cancelled" });

    const row = await getInteraction(system, published.interactionId);
    if (!row) throw new Error("interaction missing");
    expect(row.status).toBe("cancelled");
    expect(
      confirmInteractionDraftState(
        {
          status: row.status as never,
          draftVersion: row.draftVersion,
          confirmedVersion: row.confirmedVersion,
          plan: row.plan as InteractionPlan,
          slots: row.slots as Record<string, unknown>,
        },
        row.draftVersion,
      ),
    ).toMatchObject({ ok: false, error: "terminal" });
  });

  it("lets only one of two concurrent edits win", async () => {
    const published = await publish([
      { name: "to", value: "a@example.test", required: true, status: "resolved" },
      { name: "subject", value: "s", required: true, status: "resolved" },
      { name: "body", value: "b", required: true, status: "resolved" },
    ]);
    const attempt = (value: string) =>
      updateInteractionFieldService(system, {
        spaceId,
        threadId,
        botId: `bot-${stamp}`,
        interactionId: published.interactionId,
        // Both quote the version they read; only the first write can still match it.
        expectedDraftVersion: 1,
        name: "subject",
        value,
        origin: "user",
      });
    const results = await Promise.allSettled([attempt("甲"), attempt("乙")]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const row = await getInteraction(system, published.interactionId);
    if (!row) throw new Error("interaction missing");
    expect(row.draftVersion).toBe(2);
    const stored = (row.slots as Record<string, unknown>).subject;
    expect(["甲", "乙"]).toContain(stored);
  });

  it("repairs a row written before reconciliation, and confirms it", async () => {
    // A row that already exists holds the model's spellings from the older writer. Reading it
    // has to work without a migration: the person's open draft must be confirmable today.
    const created = await system.interaction.create({
      data: {
        spaceId,
        threadId,
        intent: "email.compose",
        status: "ready_for_review",
        draftVersion: 1,
        plan: EMAIL_PLAN([
          { name: "to", required: true, status: "missing" },
          { name: "subject", required: true, status: "missing" },
          { name: "body", required: true, status: "missing" },
          { name: "To", value: "legacy@example.test", required: true, status: "resolved" },
          { name: "Subject", value: "旧", required: true, status: "resolved" },
          { name: "Body", value: "旧正文", required: true, status: "resolved" },
        ]) as never,
        slots: { To: "legacy@example.test", Subject: "旧", Body: "旧正文" } as never,
      },
    });
    // The edit path republishes into the row's existing surface, so the fixture needs one.
    await system.interactionSurface.create({
      data: {
        interactionId: created.id,
        surfaceId: `surface-${stamp}-legacy`,
        protocolFamily: "v0_9",
        document: [] as never,
        draftVersion: 1,
      },
    });

    // The stored shape alone does not satisfy the gate, which is the defect being repaired.
    const before = await getInteraction(system, created.id);
    if (!before) throw new Error("interaction missing");
    expect(
      confirmInteractionDraftState(
        {
          status: before.status as never,
          draftVersion: before.draftVersion,
          confirmedVersion: before.confirmedVersion,
          plan: before.plan as InteractionPlan,
          slots: before.slots as Record<string, unknown>,
        },
        before.draftVersion,
      ).ok,
    ).toBe(false);

    // An edit repairs it through the ordinary path.
    await updateInteractionFieldService(system, {
      spaceId,
      threadId,
      botId: `bot-${stamp}`,
      interactionId: created.id,
      expectedDraftVersion: 1,
      name: "subject",
      value: "修好了",
      origin: "user",
    });
    const after = await getInteraction(system, created.id);
    if (!after) throw new Error("interaction missing");
    const plan = after.plan as InteractionPlan;
    const slots = after.slots as Record<string, unknown>;
    expect(plan.fields.filter((field) => field.name === "to")).toHaveLength(1);
    expect(interactionSlotsFromPlan(plan)).toEqual(slots);
    expect(
      confirmInteractionDraftState(
        {
          status: after.status as never,
          draftVersion: after.draftVersion,
          confirmedVersion: after.confirmedVersion,
          plan,
          slots,
        },
        after.draftVersion,
      ),
    ).toMatchObject({ ok: true });
  });

  it("keeps a waiting draft's values intact when only its status changes", async () => {
    // This is about the row, not about resume. Resume lives in the API and rewrites the thread's
    // surface; what is pinned here is the weaker property it relies on: a status-only write to
    // the row leaves plan, slots and confirmation alone. The resume path itself is covered by
    // apps/api/src/interaction-connection-recovery.postgres.test.ts.
    const published = await publish([
      { name: "to", value: "waiting@example.test", required: true, status: "resolved" },
      { name: "subject", value: "等等", required: true, status: "resolved" },
      { name: "body", value: "正文", required: true, status: "resolved" },
    ]);
    await system.interaction.updateMany({
      where: { id: published.interactionId },
      data: { status: "needs_connection" },
    });
    const waiting = await getInteraction(system, published.interactionId);
    if (!waiting) throw new Error("interaction missing");
    expect(waiting.status).toBe("needs_connection");
    expect((waiting.slots as Record<string, unknown>).body).toBe("正文");
    expect(waiting.confirmedVersion).toBeNull();
  });
});
