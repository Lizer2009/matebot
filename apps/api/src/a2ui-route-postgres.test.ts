import type { Actor } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { createDb, runAsSystem, runAsTenant } from "@matebot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

/**
 * The real route over the real database.
 *
 * The in-memory route test proves wiring; this proves the same requests against
 * a migrated Postgres with actual constraints, actual transactions and actual
 * row-level security. `threads.editInteraction` runs `updateInteractionFieldService`,
 * which writes inside a transaction, bumps the revision, and republishes the
 * surface — so a passing run here means the whole chain really persisted.
 *
 * Needs a disposable database (`VERIFY_DATABASE`), never a production one.
 */

const url = process.env.DATABASE_URL;
const verify = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let closeDb: () => Promise<void>;
const spaceId = "a2ui-rt-space";
const userId = "a2ui-rt-user";
const botId = "a2ui-rt-bot";
const threadId = "a2ui-rt-thread";
const interactionId = "a2ui-rt-ix";
const surfaceId = "a2ui-rt-surf";

const actor: Actor = {
  spaceId,
  userId,
  email: "verify@example.test",
  isDeploymentOwner: true,
};

const plan = {
  intent: "email.compose",
  title: "Email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved" },
    { name: "subject", value: "Hi", required: true, status: "resolved" },
    { name: "body", value: "Hello", required: true, status: "resolved" },
  ],
  nextStep: "ask",
  riskLevel: "medium",
};

async function cleanup() {
  await runAsSystem("a2ui route verification cleanup", async () => {
    await prisma.$executeRaw`DELETE FROM interaction_surfaces WHERE "interactionId" LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM interactions WHERE id LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM messages WHERE id LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM runs WHERE id LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM tasks WHERE id LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM threads WHERE id LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM bots WHERE id LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM spaces WHERE id LIKE 'a2ui-rt%'`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id LIKE 'a2ui-rt%'`;
  });
}

function router(handlerDeps: RouterDeps) {
  return new RPCHandler(createRouter(handlerDeps));
}

async function rpc(
  handler: InstanceType<typeof RPCHandler>,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const { response } = await handler.handle(
    new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  if (!response) throw new Error(`no response for ${path}`);
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  const created = createDb(url!);
  prisma = created.prisma;
  closeDb = () => created.pool.end();
  await cleanup();
  // Real dependency order, matching the migrated constraints.
  await runAsSystem("a2ui route verification fixture", async () => {
    await prisma.$executeRaw`INSERT INTO organization (id, name, slug, "createdAt", metadata)
      VALUES (${`${spaceId}-org`}, 'verify', ${`${spaceId}-org`}, now(), '{}'::jsonb)`;
    await prisma.$executeRaw`INSERT INTO spaces (id, "organizationId", name, "createdAt")
      VALUES (${spaceId}, ${`${spaceId}-org`}, 'verify', now())`;
    await prisma.$executeRaw`INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt")
      VALUES (${botId}, ${spaceId}, ${userId}, 'verify', '#111111', now())`;
    // threads_owner_chk: exactly one of botId / groupId / externalConversationId.
    await prisma.$executeRaw`INSERT INTO threads (id, "spaceId", "botId", "userId")
      VALUES (${threadId}, ${spaceId}, ${botId}, ${userId})`;
    await prisma.$executeRaw`INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
      VALUES (${`${spaceId}-task`}, ${spaceId}, ${botId}, ${threadId}, ${userId}, 'verify', 'completed', now())`;
    await prisma.$executeRaw`INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger, "updatedAt")
      VALUES (${`${spaceId}-run`}, ${spaceId}, ${botId}, ${threadId}, ${`${spaceId}-task`}, ${userId}, 'completed', 'user', now())`;
    await prisma.$executeRaw`INSERT INTO interactions (id, "spaceId", "threadId", "runId", intent, status, "draftVersion", plan, slots, title, "createdAt", "updatedAt")
      VALUES (${interactionId}, ${spaceId}, ${threadId}, ${`${spaceId}-run`}, 'email.compose', 'ready_for_review', 2, ${JSON.stringify(plan)}::jsonb, ${JSON.stringify({ to: "a@example.com", subject: "Hi", body: "Hello" })}::jsonb, 'Email', now(), now())`;
    await prisma.$executeRaw`INSERT INTO interaction_surfaces (id, "interactionId", "surfaceId", "protocolFamily", document, "draftVersion", "createdAt", "updatedAt")
      VALUES (${`${surfaceId}-row`}, ${interactionId}, ${surfaceId}, 'v0_9', '[]'::jsonb, 2, now(), now())`;
  });
});

afterAll(async () => {
  if (!prisma) return;
  await cleanup();
  await closeDb();
});

/** Deps that differ from production only where a real service is unavailable. */
function deps(): RouterDeps {
  return {
    prisma,
    jobs: { enqueue: async () => undefined, cancel: async () => undefined },
    events: {
      notify: async () => undefined,
      subscribe: async () => undefined,
      answerRunInput: async () => true,
    },
    env: {
      defaultProvider: "deepseek",
      defaultModel: "deepseek-flash",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/matebot-a2ui-route-pg",
    connectors: { managed: () => undefined, managedProviders: () => [] },
  } as unknown as RouterDeps;
}

verify("threads.editInteraction against a real database", () => {
  it("persists the new revision and the surface row in one transaction", async () => {
    process.env.FEATURE_A2UI = "1";
    const handler = router(deps());
    const { status, json } = await rpc(handler, "threads/editInteraction", {
      botId,
      interactionId,
      revision: 2,
      fields: { subject: "秋后问候" },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ json: { ok: true, interactionId, draftVersion: 3 } });

    // Read it back from Postgres, not from the response.
    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: interactionId } }),
    );
    expect(row?.draftVersion).toBe(3);
    expect(row?.confirmedVersion).toBeNull();
    expect(row?.slots).toMatchObject({ subject: "秋后问候" });

    const surface = await runAsTenant({ spaceId, userId }, () =>
      prisma.interactionSurface.findFirst({ where: { interactionId } }),
    );
    expect(surface?.draftVersion).toBe(3);
  });

  it("refuses a stale revision against the real row", async () => {
    const handler = router(deps());
    const { status, json } = await rpc(handler, "threads/editInteraction", {
      botId,
      interactionId,
      revision: 2,
      fields: { subject: "stale" },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("stale_revision");
    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: interactionId } }),
    );
    // Unchanged by the refused request.
    expect(row?.draftVersion).toBe(3);
    expect(row?.slots).toMatchObject({ subject: "秋后问候" });
  });

  it("keeps one interaction and one surface after two edits", async () => {
    const handler = router(deps());
    await rpc(handler, "threads/editInteraction", {
      botId,
      interactionId,
      revision: 3,
      fields: { body: "second edit" },
    });
    const count = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.count({ where: { threadId } }),
    );
    const surfaces = await runAsTenant({ spaceId, userId }, () =>
      prisma.interactionSurface.count({ where: { interactionId } }),
    );
    // Same card revised, not a second card created.
    expect(count).toBe(1);
    expect(surfaces).toBe(1);
  });

  it("refuses another tenant's interaction through the route", async () => {
    process.env.FEATURE_A2UI = "1";
    const other: Actor = { ...actor, spaceId: "a2ui-rt-other-space" };
    const handler = router(deps());
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/editInteraction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { botId, interactionId, revision: 4, fields: { subject: "hijack" } },
        }),
      }),
      { prefix: "/rpc", context: { actor: other } },
    );
    expect(response).toBeTruthy();
    // The other tenant cannot even resolve this bot, so the call fails.
    expect(((await response!.json()) as { json?: { code?: string } }).json?.code).toBeTruthy();
    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: interactionId } }),
    );
    expect(row?.slots).not.toMatchObject({ subject: "hijack" });
  });
});

/**
 * The rules that only a real database can prove: the value the person typed
 * survives a model edit, cancelling a draft persists and keeps its surface, and
 * a record that already ran is never edited in place.
 */
verify("field protection, cancel, and executed records against a real database", () => {
  const ixId = "a2ui-rt-protect";
  const surfId = "a2ui-rt-protect-surf";

  async function seed(status: string, planOverride?: unknown) {
    await runAsSystem("a2ui protect fixture", async () => {
      await prisma.$executeRaw`DELETE FROM interaction_surfaces WHERE "interactionId" = ${ixId}`;
      await prisma.$executeRaw`DELETE FROM interactions WHERE id = ${ixId}`;
      await prisma.$executeRaw`INSERT INTO interactions (id, "spaceId", "threadId", "runId", intent, status, "draftVersion", plan, slots, title, "createdAt", "updatedAt")
        VALUES (${ixId}, ${spaceId}, ${threadId}, ${`${spaceId}-run`}, 'email.compose', ${status}, 2, ${JSON.stringify(planOverride ?? plan)}::jsonb, ${JSON.stringify({ to: "a@example.com", subject: "Hi", body: "Hello" })}::jsonb, 'Email', now(), now())`;
      await prisma.$executeRaw`INSERT INTO interaction_surfaces (id, "interactionId", "surfaceId", "protocolFamily", document, "draftVersion", "createdAt", "updatedAt")
        VALUES (${`${surfId}-row`}, ${ixId}, ${surfId}, 'v0_9', '[]'::jsonb, 2, now(), now())`;
    });
  }

  it("keeps a value the person typed when a model edit arrives later", async () => {
    process.env.FEATURE_A2UI = "1";
    // The card's own control runs first and stamps the field as the user's.
    await seed("ready_for_review");
    const handler = router(deps());
    const typed = await rpc(handler, "threads/updateInteractionField", {
      botId,
      interactionId: ixId,
      expectedDraftVersion: 2,
      name: "subject",
      value: "我写的主题",
    });
    expect(typed.status).toBe(200);

    // A model edit for the same field arrives afterwards.
    const edited = await rpc(handler, "threads/editInteraction", {
      botId,
      interactionId: ixId,
      revision: 3,
      fields: { subject: "model subject" },
    });
    expect(edited.status).toBe(200);

    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: ixId } }),
    );
    // The typed value is still there, read back from Postgres.
    expect(row?.slots).toMatchObject({ subject: "我写的主题" });
  });

  it("cancels a draft and persists that state on the same surface", async () => {
    process.env.FEATURE_A2UI = "1";
    await seed("ready_for_review");
    const handler = router(deps());
    const cancelled = await rpc(handler, "threads/cancelInteraction", {
      botId,
      interactionId: ixId,
      draftVersion: 2,
    });
    expect(cancelled.status).toBe(200);

    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: ixId } }),
    );
    expect(row?.status).toBe("cancelled");
    const surfaces = await runAsTenant({ spaceId, userId }, () =>
      prisma.interactionSurface.count({ where: { interactionId: ixId } }),
    );
    // The card is republished in place, not deleted and not duplicated.
    expect(surfaces).toBe(1);
  });

  /**
   * R4: what the person discards through the product route cannot be sent afterwards.
   *
   * Cancelling a draft and then confirming it is the sequence that matters — every later step
   * (confirm, execute) has to refuse, not just the cancel returning 200. This goes through the
   * same `threads.cancelInteraction` the Discard button calls, on the real row.
   */
  it("refuses to confirm a draft the person discarded through the product route", async () => {
    process.env.FEATURE_A2UI = "1";
    await seed("ready_for_review");
    const handler = router(deps());

    const cancelled = await rpc(handler, "threads/cancelInteraction", {
      botId,
      interactionId: ixId,
      draftVersion: 2,
    });
    expect(cancelled.status).toBe(200);

    // Confirming the discarded draft must not go through at its old revision.
    const confirmed = await rpc(handler, "threads/confirmInteraction", {
      botId,
      interactionId: ixId,
      draftVersion: 2,
    });
    expect(confirmed.status).not.toBe(200);

    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: ixId } }),
    );
    expect(row?.status).toBe("cancelled");
    // Nothing was confirmed, so nothing can execute from it.
    expect(row?.confirmedVersion).toBeNull();
  });

  it("refuses to execute a draft the person discarded", async () => {
    process.env.FEATURE_A2UI = "1";
    await seed("ready_for_review");
    const handler = router(deps());

    await rpc(handler, "threads/cancelInteraction", {
      botId,
      interactionId: ixId,
      draftVersion: 2,
    });
    const executed = await rpc(handler, "threads/executeInteraction", {
      botId,
      interactionId: ixId,
      draftVersion: 2,
    });
    expect(executed.status).not.toBe(200);

    // No effect row was created: a discarded card sends nothing.
    const effects = await runAsTenant({ spaceId, userId }, () =>
      prisma.externalEffect.findMany({ where: { spaceId } }),
    );
    expect(effects).toEqual([]);
  });

  it("refuses to edit a draft the person discarded", async () => {
    // A discarded card cannot be quietly brought back by a later field write either.
    process.env.FEATURE_A2UI = "1";
    await seed("ready_for_review");
    const handler = router(deps());

    await rpc(handler, "threads/cancelInteraction", {
      botId,
      interactionId: ixId,
      draftVersion: 2,
    });
    const edited = await rpc(handler, "threads/updateInteractionField", {
      botId,
      interactionId: ixId,
      expectedDraftVersion: 3,
      name: "subject",
      value: "还想改",
    });
    expect(edited.status).not.toBe(200);

    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: ixId } }),
    );
    expect(row?.status).toBe("cancelled");
  });

  it("refuses to cancel a record that already executed", async () => {
    process.env.FEATURE_A2UI = "1";
    await seed("succeeded");
    const handler = router(deps());
    const refused = await rpc(handler, "threads/cancelInteraction", {
      botId,
      interactionId: ixId,
      draftVersion: 2,
    });
    expect(refused.status).toBe(409);
    const row = await runAsTenant({ spaceId, userId }, () =>
      prisma.interaction.findUnique({ where: { id: ixId } }),
    );
    // The record of what happened is unchanged.
    expect(row?.status).toBe("succeeded");
  });
});
