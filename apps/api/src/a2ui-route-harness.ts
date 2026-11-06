import type { Actor, InteractionSurfaceSchema } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { RPCHandler } from "@orpc/server/fetch";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

/**
 * Route-level integration over real HTTP through the real oRPC router, with an
 * in-memory Prisma client. There is no Postgres or Docker in this environment,
 * so this is the closest honest substitute for a database-backed route test: the
 * request body, routing, middleware, handler, and response shape are all real.
 *
 * What this cannot prove: SQL constraints, transactions, and isolation. Those
 * remain covered by the `.postgres.test.ts` suites that need a real database.
 */

type InteractionRow = {
  id: string;
  spaceId: string;
  threadId: string;
  runId: string | null;
  intent: string;
  status: string;
  draftVersion: number;
  confirmedVersion: number | null;
  plan: unknown;
  slots: Record<string, unknown>;
  title: string | null;
  summary: string | null;
  approvalEffectId: string | null;
  messageId: string | null;
};

export const emailSchema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true },
    { name: "subject", label: "Subject", kind: "text", required: true },
    { name: "body", label: "Message", kind: "longText", required: true },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

export const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
};

/** A router whose surfaces/fields read and write an in-memory interaction. */
export function interactionHarness(input: {
  interaction?: Partial<InteractionRow>;
  surfaceId?: string;
}) {
  const row: InteractionRow = {
    id: "ix-1",
    spaceId: actor.spaceId,
    threadId: "thread-1",
    runId: "run-1",
    intent: "email.compose",
    status: "ready_for_review",
    draftVersion: 2,
    confirmedVersion: null,
    // The plan mirrors the registered schema: field edits validate against it.
    plan: {
      intent: "email.compose",
      title: "Email",
      fields: [
        { name: "to", value: "a@example.com", required: true, status: "resolved" },
        { name: "subject", value: "Hi", required: true, status: "resolved" },
        { name: "body", value: "Hello", required: true, status: "resolved" },
      ],
      nextStep: "ask",
      riskLevel: "medium",
    },
    slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    title: "Email",
    summary: null,
    approvalEffectId: null,
    messageId: "msg-1",
    ...input.interaction,
  };
  const surfaceId = input.surfaceId ?? "surf-1";
  /** Every republish, so a test can prove one surface moved rather than two. */
  const published: Array<{ draftVersion: number; surfaceId: string }> = [];
  const message = { id: "msg-1", blocks: [] as unknown[] };

  const surfaceRow = () => ({
    interactionId: row.id,
    surfaceId,
    protocolFamily: "v0_9",
    document: [],
    draftVersion: row.draftVersion,
  });

  const tx = {
    interaction: {
      findUnique: async () => row,
      findFirst: async () => row,
      // The edit route reads each card's newest surface to decide targets.
      findMany: async () => [{ ...row, surfaces: [{ surfaceId }] }],
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.draftVersion !== undefined && where.draftVersion !== row.draftVersion) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return row;
      },
    },
    interactionSurface: {
      findFirst: async () => surfaceRow(),
      findUnique: async () => surfaceRow(),
      upsert: async ({ create }: { create: { draftVersion: number } }) => {
        published.push({ draftVersion: create.draftVersion, surfaceId });
        return { ...surfaceRow(), draftVersion: create.draftVersion };
      },
    },
    message: {
      findUnique: async () => message,
      update: async ({ data }: { data: { blocks: unknown[] } }) => {
        message.blocks = data.blocks;
        return message;
      },
    },
    run: {
      findUnique: async () => ({ id: "run-1", botId: "bot-1" }),
      findFirst: async () => ({ id: "run-1" }),
    },
    externalEffect: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "effect-1", ...data }),
      updateMany: async () => ({ count: 1 }),
    },
    event: {
      findFirst: async () => null,
      // appendEventInTransaction writes one row and reads back its seq.
      create: async () => ({ id: "event-1", seq: 1, type: "thread.surface.updated" }),
      findMany: async () => [],
    },
    thread: {
      update: async ({ data }: { data: { nextEventSeq?: { increment?: number } } }) => ({
        nextEventSeq: (data.nextEventSeq?.increment ?? 1) + 1,
      }),
      findFirst: async () => ({ id: "thread-1", spaceId: actor.spaceId }),
      findUnique: async () => ({ id: "thread-1", spaceId: actor.spaceId, nextEventSeq: 1 }),
    },
    $executeRaw: async () => undefined,
    $queryRaw: async () => [],
  };

  const prisma = {
    ...tx,
    thread: { findFirst: async () => ({ id: "thread-1", spaceId: actor.spaceId }) },
    message: { ...tx.message, findMany: async () => [message], findFirst: async () => message },
    run: {
      ...tx.run,
      findMany: async () => [{ id: "run-1", botId: "bot-1", status: "completed" }],
    },
    // `getBot` includes the thread, and a bot with no thread is an isolation error.
    bot: {
      findFirst: async () => ({
        id: "bot-1",
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
        thread: { id: "thread-1", spaceId: actor.spaceId },
        computer: null,
      }),
    },
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx),
    $queryRaw: async () => [],
  } as unknown as PrismaClient;

  const deps = {
    prisma,
    jobs: { enqueue: async () => undefined, cancel: async () => undefined },
    events: {
      notify: async () => undefined,
      subscribe: async () => undefined,
      answerRunInput: async () => true,
    },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/matebot-a2ui-route-test",
    connectors: { managed: () => undefined, managedProviders: () => [] },
  } as unknown as RouterDeps;

  // A throw in a handler becomes a 500 with a sanitized message, so the test
  // keeps the real error instead of guessing what failed.
  const failures: unknown[] = [];
  const handler = new RPCHandler(createRouter(deps), {
    clientInterceptors: [
      async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
    ],
  });
  return { row, published, surfaceId, handler, deps, prisma, failures };
}

/** POST a JSON body to an RPC path, exactly as a client would. */
export async function rpc(
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
