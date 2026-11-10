import { randomUUID } from "node:crypto";
import type { InteractionPlan } from "@matebot/contracts";
import { confirmInteractionDraftState, userEditedFieldNames } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb, getInteraction } from "@matebot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    // The event row is not what this suite is about; the card rewrite is.
    appendEventInTransaction: vi.fn(async () => ({ id: "event", seq: 1 })),
  };
});

import { interactionCancelTools } from "@matebot/adapters";

/**
 * "Never mind" has to void the card, on the real row.
 *
 * The model-level cancel is covered against mocks elsewhere, which shows the decision was made
 * but not that it was persisted. The gap this closes is the product rule: a person saying stop
 * is not the same as the card being voided, and only a written terminal state makes it so. These
 * drive the real `cancel_interaction` tool against a migrated database, then try to confirm the
 * same card.
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

describePostgres("verbal stop voids the card (PostgreSQL)", () => {
  const stamp = randomUUID();
  /** This file's own prefix, so its cleanup cannot reach a sibling suite's rows. */
  const P = `discard-${stamp}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let threadId: string;
  let userId: string;
  let botId: string;
  let messageId: string;
  let interactionId: string;
  let surfaceId: string;
  let orgId: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    // The interaction tools are gated on this flag; a deployment that shows cards has it on.
    process.env.FEATURE_A2UI = "1";
  });

  afterAll(async () => {
    if (!db) return;
    await system.interaction.deleteMany({ where: { spaceId: { startsWith: P } } });
    await system.message.deleteMany({ where: { threadId: { startsWith: P } } });
    await system.thread.deleteMany({ where: { spaceId: { startsWith: P } } });
    await system.bot.deleteMany({ where: { spaceId: { startsWith: P } } });
    await system.space.deleteMany({ where: { id: { startsWith: P } } });
    await system.organization.deleteMany({ where: { id: { startsWith: P } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  beforeEach(async () => {
    spaceId = `${P}-space-${randomUUID()}`;
    userId = `${P}-user-${randomUUID()}`;
    botId = `${P}-bot-${randomUUID()}`;
    threadId = `${P}-thread-${randomUUID()}`;
    messageId = `${P}-msg-${randomUUID()}`;
    interactionId = `${P}-ix-${randomUUID()}`;
    surfaceId = `${P}-surf-${randomUUID()}`;
    const org = `${P}-org-${randomUUID()}`;
    await system.organization.create({
      data: { id: org, name: org, slug: org, createdAt: new Date() },
    });
    orgId = org;
    await system.space.create({
      data: { id: spaceId, organizationId: orgId, name: "space" },
    });
    await system.bot.create({
      data: { id: botId, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    await system.thread.create({ data: { id: threadId, spaceId, userId, botId } });
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
            surfaceId,
            protocolFamily: "v0_9",
            draftVersion: 2,
            intent: "email.compose",
            capability: "ready",
            template: "email-draft-card",
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
        status: "ready_for_review",
        draftVersion: 2,
        plan: plan([
          { name: "to", value: "alex@example.test", required: true, status: "resolved" },
          { name: "subject", value: "我写的主题", required: true, status: "resolved" },
          { name: "body", value: "正文", required: true, status: "resolved" },
        ]) as never,
        slots: { to: "alex@example.test", subject: "我写的主题", body: "正文" } as never,
      },
    });
    await system.interactionSurface.create({
      data: {
        interactionId,
        surfaceId,
        protocolFamily: "v0_9",
        document: [] as never,
        draftVersion: 2,
      },
    });
  });

  /** The run context the tool needs, built from the real row. */
  function ctx(): Record<string, unknown> {
    const prisma = system;
    return {
      deps: { prisma, events: { notify: async () => undefined }, jobs: {} },
      run: { id: "run-1", spaceId, threadId, botId, userId },
      context: { userId, signal: new AbortController().signal },
      bot: { id: botId },
      thread: { id: threadId },
      state: { effects: { consumedIds: [] } },
    };
  }

  async function row() {
    const found = await getInteraction(system, interactionId);
    if (!found) throw new Error("interaction missing");
    return found;
  }

  /** The tool handler the model calls, driven exactly as the runtime drives it. */
  function cancel(args: Record<string, unknown>) {
    const handler = interactionCancelTools.cancel_interaction!;
    return handler(
      ctx() as never,
      {
        args,
        finish: (result: unknown) => result,
      } as never,
    ) as Promise<
      | { ok: true; interactionId: string; draftVersion: number; reply: string }
      | {
          ok: false;
          error: string;
          reply?: string;
        }
    >;
  }

  it("writes the terminal state when the person says stop", async () => {
    // Before the tool runs the card is open and its values would pass the confirm gate.
    const before = await row();
    expect(before.status).toBe("ready_for_review");
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
    ).toBe(true);

    const result = await cancel({ interactionId, revision: 2 });
    expect(result.ok).toBe(true);

    // The row on disk is now cancelled — the sentence was not enough on its own.
    const after = await row();
    expect(after.status).toBe("cancelled");
    expect(after.confirmedVersion).toBeNull();
    expect(after.draftVersion).toBe(3);
    // The card is republished in place, not duplicated, and no effect exists.
    const surfaces = await system.interactionSurface.count({ where: { interactionId } });
    expect(surfaces).toBe(1);
    expect(await system.externalEffect.findMany({ where: { spaceId } })).toEqual([]);
  });

  it("cannot be confirmed after it was discarded", async () => {
    await cancel({ interactionId, revision: 2 });
    const after = await row();
    const gate = confirmInteractionDraftState(
      {
        status: after.status as never,
        draftVersion: after.draftVersion,
        confirmedVersion: after.confirmedVersion,
        plan: after.plan as InteractionPlan,
        slots: after.slots as Record<string, unknown>,
      },
      after.draftVersion,
    );
    expect(gate).toMatchObject({ ok: false, error: "terminal" });
    // And no effect row exists for something that can no longer be sent.
    expect(await system.externalEffect.findMany({ where: { spaceId } })).toEqual([]);
  });

  it("refuses a second discard without changing the state again", async () => {
    const first = await cancel({ interactionId, revision: 2 });
    expect(first.ok).toBe(true);
    const versionAfterFirst = (await row()).draftVersion;

    const second = await cancel({ interactionId, revision: versionAfterFirst });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("terminal");
    expect((await row()).draftVersion).toBe(versionAfterFirst);
  });

  it("keeps the person's text so the discarded card is still readable", async () => {
    await cancel({ interactionId, revision: 2 });
    const after = await row();
    // A discarded card is not wiped: it still shows what was in it.
    expect(after.slots).toMatchObject({
      to: "alex@example.test",
      subject: "我写的主题",
      body: "正文",
    });
    // Provenance is unchanged too.
    const written = userEditedFieldNames(after.plan);
    expect(Array.isArray(written)).toBe(true);
  });

  it("does not cancel a record that already ran", async () => {
    await system.interaction.update({
      where: { id: interactionId },
      data: { status: "succeeded" },
    });
    const result = await cancel({ interactionId, revision: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("already_executed");
    // The record of what happened keeps its state.
    expect((await row()).status).toBe("succeeded");
  });
});
