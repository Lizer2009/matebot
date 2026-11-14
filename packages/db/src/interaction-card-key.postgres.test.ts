import { readFile } from "node:fs/promises";
import { interactionCardKey } from "@matebot/core/node/interaction-card-key";
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

  it("keeps one open row when concurrent inserts race on the same key", async () => {
    const key = interactionCardKey(threadId, `race-${suffix}`);
    const results = await Promise.allSettled([
      insert(key, "collecting"),
      insert(key, "ready_for_review"),
      insert(key, "awaiting_approval"),
    ]);
    const ok = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(2);
    expect(failed.every((result) => result.reason?.code === "P2002")).toBe(true);
    expect(await prisma.interaction.count({ where: { threadId, cardKey: key } })).toBe(1);
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

  it("keeps the kernel status CHECK the vocabulary depends on (AC-4)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"interactions"'::regclass
        AND conname = 'interactions_status_kernel_check'
    `;
    expect(rows).toHaveLength(1);
  });

  it("refuses executing and other values the thirteen-word list does not contain", async () => {
    const key = interactionCardKey(threadId, `bogus-${suffix}`);
    await expect(insert(key, "executing")).rejects.toBeTruthy();
    await expect(insert(key, "submitting")).rejects.toBeTruthy();
    await expect(insert(key, "totally_bogus")).rejects.toBeTruthy();
    await expect(
      createInteraction(prisma, {
        spaceId,
        threadId,
        intent: `create-executing-${suffix}`,
        status: "executing" as never,
        plan,
      }),
    ).rejects.toThrow(/kernel vocabulary/);
  });

  it("keeps an open kernel status occupying the slot so a send cannot sit beside a new draft", async () => {
    const key = interactionCardKey(threadId, `occupy-${suffix}`);
    await insert(key, "ready_for_review");
    await expect(insert(key, "collecting")).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.interaction.updateMany({
        where: { cardKey: key },
        data: { status: "executing" },
      }),
    ).rejects.toBeTruthy();
  });

  it("remaps historical executing beside collecting to one open card (never succeeded)", async () => {
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261129120000_interaction_status_check/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toMatch(/ready_for_review/);
    expect(migration).not.toMatch(/SET "status" = 'succeeded'/);
    await prisma.$executeRawUnsafe(`
      CREATE TEMP TABLE interactions_mig (
        id text PRIMARY KEY,
        status text NOT NULL,
        "cardKey" text,
        "updatedAt" timestamptz NOT NULL
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO interactions_mig (id, status, "cardKey", "updatedAt") VALUES
        ('old-executing', 'executing', 'same-key', TIMESTAMPTZ '2026-11-01 00:00:00+00'),
        ('new-collecting', 'collecting', 'same-key', TIMESTAMPTZ '2026-11-02 00:00:00+00'),
        ('junk', 'totally_bogus', 'other-key', TIMESTAMPTZ '2026-11-02 00:00:00+00')
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE interactions_mig SET status = 'ready_for_review' WHERE status IN ('executing', 'submitting')
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE interactions_mig SET status = 'unknown' WHERE status NOT IN (
        'collecting','ready_for_review','awaiting_approval','needs_connection','unknown',
        'sent','executed','succeeded','confirmed','superseded','expired','failed','cancelled'
      )
    `);
    await prisma.$executeRawUnsafe(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY "cardKey" ORDER BY "updatedAt" DESC, id DESC) AS rn
        FROM interactions_mig
        WHERE status IN ('collecting', 'ready_for_review', 'awaiting_approval')
          AND "cardKey" IS NOT NULL
      )
      UPDATE interactions_mig AS i SET status = 'superseded' FROM ranked AS r
      WHERE i.id = r.id AND r.rn > 1
    `);
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `SELECT id, status FROM interactions_mig ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: "junk", status: "unknown" },
      { id: "new-collecting", status: "collecting" },
      { id: "old-executing", status: "superseded" },
    ]);
    await prisma.$executeRawUnsafe(`DROP TABLE interactions_mig`);
  });

  it("runs the original backfill CTE against empty, duplicate, and terminal fixtures (AC-3)", async () => {
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261126120000_interaction_card_key/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const cte = /WITH ranked AS \([\s\S]*?WHERE i\."id" = r\."id" AND r\.rn > 1;/.exec(
      migration,
    )?.[0];
    expect(cte).toBeTruthy();
    const rewritten = cte!.replaceAll('"interactions"', '"interactions_ac3"');
    await prisma.$executeRawUnsafe(`
      CREATE TEMP TABLE interactions_ac3 (
        id text PRIMARY KEY,
        status text NOT NULL,
        "cardKey" text,
        "updatedAt" timestamptz NOT NULL
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO interactions_ac3 (id, status, "cardKey", "updatedAt") VALUES
        ('empty-open', 'collecting', 'k-empty', TIMESTAMPTZ '2026-11-01 00:00:00+00'),
        ('dup-old', 'collecting', 'k-dup', TIMESTAMPTZ '2026-11-01 00:00:00+00'),
        ('dup-new', 'ready_for_review', 'k-dup', TIMESTAMPTZ '2026-11-02 00:00:00+00'),
        ('term', 'succeeded', 'k-term', TIMESTAMPTZ '2026-11-02 00:00:00+00'),
        ('term-open', 'collecting', 'k-term', TIMESTAMPTZ '2026-11-03 00:00:00+00')
    `);
    await prisma.$executeRawUnsafe(rewritten);
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `SELECT id, status FROM interactions_ac3 ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: "dup-new", status: "ready_for_review" },
      { id: "dup-old", status: "superseded" },
      { id: "empty-open", status: "collecting" },
      { id: "term", status: "succeeded" },
      { id: "term-open", status: "collecting" },
    ]);
    await prisma.$executeRawUnsafe(`DROP TABLE interactions_ac3`);
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

  // The backfill writes the key in SQL and everything after it writes the key in JS.
  // If the two ever disagree, old rows and new rows hold different identities for the
  // same (thread, intent) and the index stops seeing the duplicate it exists to stop.
  // The expression is read from the migration itself, so editing that file moves this
  // test with it instead of leaving a hand-copied duplicate passing on its own.
  it("backfills with the digest the application computes", async () => {
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261126120000_interaction_card_key/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const expression = /SET "cardKey" = ([\s\S]*?)\nWHERE "cardKey" IS NULL/.exec(migration)?.[1];
    expect(expression).toBeTruthy();

    const pairs: Array<[string, string]> = [
      [`card-key-ascii-${suffix}`, "email.compose"],
      [`card-key-线程-${suffix}`, "邮件.发送"],
      // Naive concatenation makes these two the same string; the NUL separator
      // is what keeps them apart.
      [`card-key-x-${suffix}`, "ab"],
      [`card-key-x-${suffix}a`, "b"],
    ];
    const keys: string[] = [];
    for (const [thread, intent] of pairs) {
      const rows = await prisma.$queryRawUnsafe<Array<{ key: string }>>(
        `SELECT ${expression} AS "key" FROM (VALUES ($1::text, $2::text)) AS t("threadId", "intent")`,
        thread,
        intent,
      );
      expect(rows[0]?.key).toBe(interactionCardKey(thread, intent));
      keys.push(rows[0]!.key);
    }
    expect(keys[2]).not.toBe(keys[3]);
  });
});
