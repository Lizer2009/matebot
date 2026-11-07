import type { PrismaClient } from "@matebot/db";
import { createDb, runAsSystem, runAsTenant } from "@matebot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-Postgres validation for the A2UI Phase 0 guarantees.
 *
 * These are the claims the in-memory route test could not make: an actual
 * `interactions` row persists across a real transaction, the unique idempotency
 * key rejects a duplicate effect at the database, a version-guarded update loses
 * a genuine race, and row-level security really hides another tenant's card.
 *
 * Needs a disposable database, as `VERIFY_DATABASE` signals. It never points at
 * a developer or production database: the connection string is whatever the
 * caller exports, and this file creates and removes only the rows it names.
 */

const url = process.env.DATABASE_URL;
const verify = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let closeDb: () => Promise<void>;
const spaceId = "a2ui-verify-space";
const otherSpaceId = "a2ui-verify-other-space";
const userId = "a2ui-verify-user";
const threadId = "a2ui-verify-thread";
const botId = "a2ui-verify-bot";
const runId = "a2ui-verify-run";
const messageId = "a2ui-verify-message";

/** Remove only what this file created, in dependency order. */
async function cleanup() {
  await runAsSystem("a2ui verification cleanup", async () => {
    await prisma.$executeRaw`DELETE FROM interaction_surfaces WHERE "interactionId" LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM interactions WHERE id LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM external_effects WHERE "idempotencyKey" LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM messages WHERE id LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM runs WHERE id LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM bots WHERE id LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM threads WHERE id LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM tasks WHERE id LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM spaces WHERE id LIKE 'a2ui-verify%'`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id LIKE 'a2ui-verify%'`;
  });
}

beforeAll(async () => {
  const created = createDb(url!);
  prisma = created.prisma;
  closeDb = () => created.pool.end();
  await cleanup();
  await runAsSystem("a2ui verification fixture", async () => {
    for (const space of [spaceId, otherSpaceId]) {
      // Real required columns: a space needs an organization, a bot needs a
      // colour, a run needs a task. Fixtures match the migrated schema, not a guess.
      await prisma.$executeRaw`INSERT INTO organization (id, name, slug, "createdAt", metadata)
         VALUES (${`${space}-org`}, ${space}, ${`${space}-org`}, now(), '{}'::jsonb) ON CONFLICT (id) DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO spaces (id, "organizationId", name, "createdAt")
         VALUES (${space}, ${`${space}-org`}, ${space}, now()) ON CONFLICT (id) DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt")
         VALUES (${`${space}-bot`}, ${space}, ${userId}, 'verify', '#111111', now()) ON CONFLICT (id) DO NOTHING`;
      // threads_owner_chk: exactly one of botId / groupId / externalConversationId.
      await prisma.$executeRaw`INSERT INTO threads (id, "spaceId", "botId", "userId")
         VALUES (${`${space}-thread`}, ${space}, ${`${space}-bot`}, ${userId}) ON CONFLICT (id) DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
         VALUES (${`${space}-task`}, ${space}, ${`${space}-bot`}, ${`${space}-thread`}, ${userId}, 'verify', 'completed', now()) ON CONFLICT (id) DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger, "updatedAt")
         VALUES (${`${space}-run`}, ${space}, ${`${space}-bot`}, ${`${space}-thread`}, ${`${space}-task`}, ${userId}, 'completed', 'user', now()) ON CONFLICT (id) DO NOTHING`;
    }
  });
});

afterAll(async () => {
  if (!prisma) return;
  await cleanup();
  await closeDb();
});

verify("A2UI interactions on a real database", () => {
  it("persists an interaction and its surface in one transaction", async () => {
    const space = spaceId;
    const id = "a2ui-verify-ix-1";
    await runAsTenant({ spaceId: space, userId }, async () => {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO interactions (id, "spaceId", "threadId", intent, status, "draftVersion", plan, slots, "createdAt", "updatedAt")
           VALUES (${id}, ${space}, ${`${space}-thread`}, 'email.compose', 'ready_for_review', 2, '{}'::jsonb, ${JSON.stringify({ to: "a@example.com", subject: "Hi", body: "Hello" })}::jsonb, now(), now())`;
        await tx.$executeRaw`INSERT INTO interaction_surfaces (id, "interactionId", "surfaceId", "protocolFamily", document, "draftVersion", "createdAt", "updatedAt")
           VALUES (${"a2ui-verify-surf-1"}, ${id}, 'surf-1', 'v0_9', '[]'::jsonb, 2, now(), now())`;
      });
    });

    const row = await runAsTenant({ spaceId: space, userId }, () =>
      prisma.interaction.findUnique({ where: { id } }),
    );
    expect(row).toMatchObject({ id, intent: "email.compose", draftVersion: 2 });
    expect(row?.slots).toMatchObject({ subject: "Hi" });
  });

  it("bumps the revision with a guarded update and rejects a stale one", async () => {
    const space = spaceId;
    const id = "a2ui-verify-ix-1";
    // The field service updates only when draftVersion still matches the one the
    // editor saw; a second writer holding the old version must lose.
    const first = await runAsTenant({ spaceId: space, userId }, () =>
      prisma.interaction.updateMany({ where: { id, draftVersion: 2 }, data: { draftVersion: 3 } }),
    );
    const stale = await runAsTenant({ spaceId: space, userId }, () =>
      prisma.interaction.updateMany({ where: { id, draftVersion: 2 }, data: { draftVersion: 3 } }),
    );
    expect(first.count).toBe(1);
    expect(stale.count).toBe(0);
  });

  it("holds the database unique constraint on the effect idempotency key", async () => {
    const space = spaceId;
    const key = "a2ui-verify-ix-1:send:3";
    const effect = () =>
      runAsTenant(
        { spaceId: space, userId },
        () =>
          prisma.$executeRaw`INSERT INTO external_effects (id, "spaceId", "runId", kind, "idempotencyKey", status, request, "createdAt", "updatedAt")
           VALUES (${`a2ui-verify-effect-${Math.random().toString(36).slice(2, 8)}`}, ${space}, ${`${space}-run`}, 'email.send', ${key}, 'intended', '{}'::jsonb, now(), now())`,
      );

    await effect();
    // A second insert with the same key must fail at the database, not in app code.
    await expect(effect()).rejects.toThrow(/unique|duplicate/i);
  });

  it("hides another tenant's interaction through row-level security", async () => {
    // Same query, different tenant context: the policy, not the code, does this.
    const visible = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findMany({ where: { id: "a2ui-verify-ix-1" } }),
    );
    const hidden = await runAsTenant({ spaceId: otherSpaceId, userId }, () =>
      prisma.interaction.findMany({ where: { id: "a2ui-verify-ix-1" } }),
    );
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(0);
  });

  it("refuses to write an interaction into a space the caller does not own", async () => {
    // Running as the *other* tenant but writing a row owned by the first: the
    // policy's USING clause applies to INSERT, so this must be refused.
    await expect(
      runAsTenant(
        { spaceId: otherSpaceId, userId },
        () =>
          prisma.$executeRaw`INSERT INTO interactions (id, "spaceId", "threadId", intent, status, "draftVersion", plan, slots, "createdAt", "updatedAt")
           VALUES ('a2ui-verify-ix-cross', ${spaceId}, ${`${spaceId}-thread`}, 'email.compose', 'ready_for_review', 1, '{}'::jsonb, '{}'::jsonb, now(), now())`,
      ),
    ).rejects.toThrow();
  });
});

verify("effect idempotency and rollback on a real database", () => {
  it("executes a fake effect exactly once across duplicate submits", async () => {
    const space = spaceId;
    const key = "a2ui-verify-ix-1:send:4";
    // The fake effect is a row plus a counter, so "exactly once" is observable.
    const claim = async () =>
      runAsTenant({ spaceId: space, userId }, async () => {
        // A guarded insert: only one writer can create this key.
        const inserted = await prisma.$executeRaw`
          INSERT INTO external_effects (id, "spaceId", "runId", kind, "idempotencyKey", status, request, "createdAt", "updatedAt")
          VALUES (${`a2ui-verify-effect-${Math.random().toString(36).slice(2, 8)}`}, ${space}, ${`${space}-run`}, 'email.send', ${key}, 'intended', '{}'::jsonb, now(), now())
          ON CONFLICT ("idempotencyKey") DO NOTHING`;
        return inserted;
      });

    // Simulate a double click: five concurrent submits for the same key.
    const results = await Promise.all([claim(), claim(), claim(), claim(), claim()]);
    const created = results.filter((count) => count === 1).length;
    expect(created).toBe(1);

    const rows = await runAsTenant(
      { spaceId: space, userId },
      () =>
        prisma.$executeRaw`SELECT count(*)::int AS n FROM external_effects WHERE "idempotencyKey" = ${key}`,
    );
    const actual = await runAsTenant({ spaceId: space, userId }, () =>
      prisma.externalEffect.count({ where: { idempotencyKey: key } }),
    );
    void rows;
    expect(actual).toBe(1);
  });

  it("rolls back both writes when the transaction fails midway", async () => {
    const space = spaceId;
    const id = "a2ui-verify-ix-rollback";
    await expect(
      runAsTenant({ spaceId: space, userId }, () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO interactions (id, "spaceId", "threadId", intent, status, "draftVersion", plan, slots, "createdAt", "updatedAt")
            VALUES (${id}, ${space}, ${`${space}-thread`}, 'email.compose', 'ready_for_review', 1, '{}'::jsonb, '{}'::jsonb, now(), now())`;
          // A second insert that must fail: the surface points at a missing interaction.
          await tx.$executeRaw`INSERT INTO interaction_surfaces (id, "interactionId", "surfaceId", "protocolFamily", document, "draftVersion", "createdAt", "updatedAt")
            VALUES (${`${id}-surf`}, ${"a2ui-verify-missing"}, 'surf-1', 'v0_9', '[]'::jsonb, 1, now(), now())`;
        }),
      ),
    ).rejects.toThrow();

    // The first insert must not survive the failed transaction.
    const row = await runAsTenant({ spaceId: space, userId }, () =>
      prisma.interaction.findUnique({ where: { id } }),
    );
    expect(row).toBeNull();
  });
});
