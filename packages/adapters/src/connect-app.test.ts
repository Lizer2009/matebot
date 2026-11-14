import type { AdapterContext, ManagedConnectorProvider } from "@matebot/adapter-kit";
import type { ConnectionCatalogItem, MessageBlock } from "@matebot/contracts";
import type * as db from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectApp } from "./connect-app.js";

const stored = vi.hoisted(() => [] as { blocks: MessageBlock[]; clientNonce: string }[]);
vi.mock("@matebot/db", async (original) => ({
  ...(await original<typeof db>()),
  createInteraction: vi.fn(async () => ({
    id: "ix-1",
    intent: "connect.gmail",
    draftVersion: 1,
    title: "Connect Gmail",
    summary: null,
  })),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    stored.push(input);
    return { id: "card" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1, firstResponse: true })),
  appendInteractionEvent: vi.fn(),
}));
const entry: ConnectionCatalogItem = {
  connectorId: "fake",
  slug: "gmail",
  name: "Gmail",
  logo: null,
  connected: false,
  noAuth: false,
};
function fixture(items = [entry], openDemand: { intent: string; status: string } | null = null) {
  const interaction = {
    findFirst: vi.fn(async () =>
      openDemand ? { id: "ix-open", intent: openDemand.intent, status: openDemand.status } : null,
    ),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUnique: vi.fn(async () => ({ status: "needs_connection", draftVersion: 1 })),
  };
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => stored),
      findFirst: vi.fn(
        async ({ where }: { where: { clientNonce: string } }) =>
          stored.find((message) => message.clientNonce === where.clientNonce) ?? null,
      ),
    },
    interaction,
  };
  const deps = {
    prisma: { $transaction: vi.fn(async (fn) => fn(tx)), interaction },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof connectApp>[0];
  const catalog = vi.fn(async () => items);
  const providers = [
    { describe: () => ({ id: "fake" }), catalog },
  ] as unknown as ManagedConnectorProvider[];
  const context = {
    spaceId: "space",
    userId: "user",
    botId: "bot",
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  } as AdapterContext;
  const target = { id: "run", spaceId: "space", botId: "bot", threadId: "chat" };
  return {
    deps,
    providers,
    context,
    target,
    catalog,
    call: (app: unknown = "Gmail", effect = "effect") =>
      connectApp(deps, providers, context, target, app, effect),
  };
}
beforeEach(() => {
  stored.length = 0;
  vi.clearAllMocks();
});
describe("connect_app execution", () => {
  it("uses only catalog fields and actor context", async () => {
    const f = fixture();
    await f.call("GMAIL");
    expect(stored).toEqual([
      {
        threadId: "chat",
        botId: "bot",
        runId: "run",
        role: "bot",
        blocks: [
          {
            kind: "app_connect",
            connectorId: "fake",
            provider: "gmail",
            name: "Gmail",
            description: "Search, read, draft, and send email.",
            logo: null,
            status: "pending",
            interactionId: "ix-1",
            cardStatus: "needs_connection",
          },
        ],
        clientNonce: "connect-app:effect",
      },
    ]);
    expect(f.catalog).toHaveBeenCalledWith(f.context, "GMAIL");
    expect(f.deps.events.notify).toHaveBeenCalledWith("chat", 1, "run");
  });
  it("does not accept model card objects or unknown apps", async () => {
    const f = fixture();
    await f.call({ app: "Gmail", name: "untrusted", logo: "untrusted" });
    expect(await f.call("unavailable")).toHaveProperty("error");
    expect(stored).toHaveLength(0);
  });
  it("returns connected state without posting", async () => {
    const f = fixture([{ ...entry, connected: true }]);
    expect(await f.call()).toMatchObject({ status: "connected" });
    expect(stored).toHaveLength(0);
  });
  it("tells the model a connected app is a connection, not an action that ran", async () => {
    // "Already connected" is L2/L3. Nothing has been executed, and a reply that conflates the
    // two is what made an earlier turn claim work it had not done.
    const f = fixture([{ ...entry, connected: true }]);
    const result = (await f.call()) as Record<string, unknown>;
    expect(result).toMatchObject({
      route: { connected: true, executed: false },
    });
    expect(String(result.message)).toMatch(/Nothing has been run/);
  });
  it("tells the model a posted catalog card is not a connection", async () => {
    const f = fixture();
    const result = (await f.call()) as Record<string, unknown>;
    expect(result).toMatchObject({ route: { connected: false, executed: false } });
    expect(String(result.message)).toMatch(/not connected yet and nothing has run/);
  });
  it("dedupes replay even after the original card connects", async () => {
    const f = fixture();
    await f.call();
    stored[0]!.blocks = stored[0]!.blocks.map(
      (block) => ({ ...block, status: "connected" }) as MessageBlock,
    );
    await f.call();
    expect(stored).toHaveLength(1);
  });
  it("reuses a pending card from a different effect", async () => {
    const f = fixture();
    await f.call();
    await f.call("gmail", "another-effect");
    expect(stored).toHaveLength(1);
  });

  it("does not post a second connection card when the compose card already needs the app (AC-26)", async () => {
    const f = fixture([entry], { intent: "email.compose", status: "needs_connection" });
    const result = await f.call();
    expect(result).toMatchObject({ status: "pending" });
    expect(stored).toHaveLength(0);
  });
});

it("falls back to the catalog when search does not recognize a featured alias", async () => {
  const f = fixture();
  f.catalog.mockImplementation(async (_context?: unknown, query?: string) =>
    query ? [] : [{ ...entry, slug: "googlecalendar", name: "Google Calendar" }],
  );
  await f.call("gcal");
  expect(stored[0]?.blocks[0]).toMatchObject({
    provider: "googlecalendar",
    name: "Google Calendar",
  });
});

it("treats an app connected through a later provider as connected", async () => {
  const f = fixture();
  const providers = [
    { describe: () => ({ id: "fake" }), catalog: async () => [entry] },
    {
      describe: () => ({ id: "other" }),
      catalog: async () => [{ ...entry, connectorId: "other", connected: true }],
    },
  ] as unknown as ManagedConnectorProvider[];
  const result = await connectApp(f.deps, providers, f.context, f.target, "Gmail", "effect");
  expect(result).toMatchObject({ status: "connected" });
  expect(stored).toHaveLength(0);
});
