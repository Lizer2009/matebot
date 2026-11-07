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
