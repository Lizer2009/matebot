import { randomUUID } from "node:crypto";
import { interactionCardKey } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb } from "@matebot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The card key is computed twice: in JS by `interactionCardKey` and in SQL by
 * the migration's backfill. If the two ever disagree, old rows and new rows
 * hold different identities for the same (thread, intent) and the partial
 * unique index stops seeing the duplicate it exists to stop.
 *
 * These cases go through a real PostgreSQL server and the exact backfill
 * expression, including the NUL separator that keeps `("ab", "c")` apart from
 * `("a", "bc")` and the UTF-8 bytes of a non-ASCII pair.
 */

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("interaction card key (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let userId: string;
  const threadIds: Record<"ascii" | "unicode" | "collisionA" | "collisionB", string> = {
    ascii: `thread-${stamp}`,
    unicode: `线程-${stamp}`,
    // `"<as...>-ab" + "c"` and `"<as...>-a" + "bc"` concatenate to the same bytes.
    collisionA: `thread-${stamp}-ab`,
    collisionB: `thread-${stamp}-a`,
  };
  const insertedIds: string[] = [];

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
    const bot = await system.bot.create({
      data: { id: `bot-${stamp}`, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    for (const id of Object.values(threadIds)) {
      await system.thread.create({ data: { id, spaceId, userId, botId: bot.id } });
    }
  });

  afterAll(async () => {
    if (db) {
      await system.interaction.deleteMany({ where: { id: { in: insertedIds } } });
      await system.thread.deleteMany({ where: { id: { in: Object.values(threadIds) } } });
      await system.organization.deleteMany({ where: { id: `org-${stamp}` } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  /** Insert one row with the migration's formula and read back what SQL chose. */
  async function insertAndReadCardKey(threadId: string, intent: string): Promise<string> {
    const id = `ix-${randomUUID()}`;
    const rows = await system.$queryRawUnsafe<Array<{ cardKey: string }>>(
      `INSERT INTO "interactions"
         ("id", "spaceId", "threadId", "intent", "cardKey", "status", "plan", "slots", "draftVersion", "updatedAt")
       VALUES (
         $1, $2, $3, $4,
         encode(sha256(convert_to($3, 'UTF8') || '\\x00'::bytea || convert_to($4, 'UTF8')), 'hex'),
         'cancelled', '{}'::jsonb, '{}'::jsonb, 1, now()
       )
       RETURNING "cardKey"`,
      id,
      spaceId,
      threadId,
      intent,
    );
    insertedIds.push(id);
    const cardKey = rows[0]?.cardKey;
    if (!cardKey) throw new Error("insert did not return a card key");
    return cardKey;
  }

  it("matches the application's key for an ASCII pair", async () => {
    const threadId = threadIds.ascii;
    expect(await insertAndReadCardKey(threadId, "email.compose")).toBe(
      interactionCardKey(threadId, "email.compose"),
    );
  });

  it("matches the application's key for a non-ASCII pair", async () => {
    const threadId = threadIds.unicode;
    expect(await insertAndReadCardKey(threadId, "邮件.发送")).toBe(
      interactionCardKey(threadId, "邮件.发送"),
    );
  });

  it("keeps pairs apart that naive concatenation would merge", async () => {
    const left = await insertAndReadCardKey(threadIds.collisionA, "c");
    const right = await insertAndReadCardKey(threadIds.collisionB, "bc");

    expect(left).toBe(interactionCardKey(threadIds.collisionA, "c"));
    expect(right).toBe(interactionCardKey(threadIds.collisionB, "bc"));
    // Without the NUL byte both would hash the same string.
    expect(left).not.toBe(right);
  });
});
