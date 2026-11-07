import type { McpOAuthSummary } from "@matebot/adapters";
import { EncryptedSecretStore, McpConnector } from "@matebot/adapters";
import type { Actor } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

/**
 * The whole recovery path, driven the way a person drives it.
 *
 * The audit saw a card claim `Connected` while the server rejected its key, then a
 * new key saved while the registered connection kept serving the old one. Three
 * pieces were already right on their own — the route resets health when the config
 * changes, the connector reconnects when the credential record moves, and the card
 * reads only health — but nothing exercised them together. "Each part looks right"
 * is not evidence that the chain recovers.
 *
 * These run the real router, the real `McpConnector` and a real encrypted store.
 * Only the server at the other end is a scripted fetch, which is the boundary where
 * a provider stops: it rejects the old key with 401 and answers the new one. The
 * check goes through the route's own `test` endpoint, which awaits the probe, so the
 * assertion is about the outcome rather than about timing.
 */

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return { ...actual, recordSecurityEvent: vi.fn(async () => undefined) };
});

const ACTOR: Actor = {
  spaceId: "space-1",
  userId: "owner-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

type Row = Record<string, unknown>;

const OLD_KEY = "old-revoked-key";
const NEW_KEY = "new-working-key";
const ENDPOINT = "https://mcp.example.test/mcp";

/** A remote MCP server that answers only the new key. */
function serverAcceptingOnlyNewKey(state: { accepted: string[] }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const authorization = request.headers.get("authorization") ?? "";
    // The audit saw exactly this: a rejected credential, reported as such.
    if (authorization !== `Bearer ${NEW_KEY}`) {
      return new Response("Invalid or revoked API key", { status: 401 });
    }
    state.accepted.push(authorization);
    const message = (await request
      .clone()
      .json()
      .catch(() => ({}))) as { id?: number; method?: string };
    if (message.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "scripted", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
    }
    return new Response(null, { status: 202 });
  });
}

function fixture() {
  const store = new EncryptedSecretStore("recovery-test-encryption-key-32-chars");
  const state = { accepted: [] as string[] };
  vi.stubGlobal("fetch", serverAcceptingOnlyNewKey(state));

  const secretRows = new Map<string, { id: string; ciphertext: string }>();
  let server: Row | null = null;
  const base = (): Row => ({
    id: "server-1",
    spaceId: ACTOR.spaceId,
    userId: ACTOR.userId,
    slug: "demo",
    name: "Demo",
    description: "",
    transport: "streamable_http",
    endpoint: ENDPOINT,
    command: null,
    args: [],
    hasArgs: false,
    env: {},
    files: {},
    headers: {},
    secretId: null,
    enabled: true,
    verbatimResults: false,
    revision: 1,
    healthStatus: "unknown",
    healthMessage: null,
    healthToolCount: null,
    healthCheckedAt: null,
    allSpaces: true,
    allBots: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const match = (where: Row = {}): boolean =>
    Boolean(server) &&
    Object.entries(where).every(([key, value]) => {
      if (key === "OR") return (value as Row[]).some((branch) => match(branch));
      if (value && typeof value === "object" && "in" in (value as object)) {
        return (value as { in: unknown[] }).in.includes((server as Row)[key]);
      }
      return (server as Row)[key] === value;
    });

  const prisma = {
    mcpServer: {
      findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
        match(where) ? [{ ...server }] : [],
      ),
      findFirst: vi.fn(async ({ where }: { where?: Row } = {}) =>
        match(where) ? { ...server } : null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        server = { ...base(), ...data };
        return { ...server };
      }),
      update: vi.fn(async ({ data }: { data: Row }) => {
        const { revision: bump, ...rest } = data as Row & { revision?: unknown };
        const increment =
          bump && typeof bump === "object" && "increment" in (bump as object)
            ? Number((bump as { increment: number }).increment)
            : 0;
        server = {
          ...(server as Row),
          ...rest,
          revision: Number((server as Row).revision) + increment,
        };
        return { ...server };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!match(where)) return { count: 0 };
        server = { ...(server as Row), ...data };
        return { count: 1 };
      }),
    },
    mcpServerSpace: { findMany: vi.fn(async () => []) },
    botMcpServer: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    mcpOAuthSession: { deleteMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 0) },
    secret: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        if (where.id) return secretRows.get(String(where.id)) ?? null;
        return null;
      }),
      findMany: vi.fn(async ({ where }: { where: Row }) => {
        const ids =
          where.id && typeof where.id === "object" ? (where.id as { in: string[] }).in : [];
        return [...secretRows.values()].filter((row) => ids.includes(row.id));
      }),
      create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
        secretRows.set(data.id, data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        if (where.id && secretRows.delete(String(where.id))) return { count: 1 };
        return { count: 0 };
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ email: ACTOR.email, emailVerified: true })),
      findUniqueOrThrow: vi.fn(async () => ({ email: ACTOR.email, name: "Owner", secrets: [] })),
    },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: ACTOR.userId }) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
  } as unknown as PrismaClient;

  // The real connector, so a probe reconnects through the code production runs.
  const connector = new McpConnector(prisma, store, {
    network: {
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        globalThis.fetch(input as never, init),
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    },
  });

  const oauth: McpOAuthSummary = { status: "none", clientId: null, credential: true };
  const deps = {
    prisma,
    secrets: store,
    remoteConnectors: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    mcpOAuth: {
      summaryFor: vi.fn(async () => oauth),
      summaryForCiphertext: vi.fn(async () => oauth),
    },
    mcp: connector,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/matebot-mcp-recovery-test",
  } as unknown as RouterDeps;

  const client = createRouterClient(createRouter(deps), { context: { actor: ACTOR } as never });
  return { client, connector, store, state, server: () => server };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const saveInput = (secret: string) => ({
  transport: "streamable_http" as const,
  slug: "demo",
  name: "Demo",
  endpoint: ENDPOINT,
  headers: {},
  secret,
  enabled: true,
  description: "",
  verbatimResults: false,
});

describe("saving a new key onto a registered MCP server", () => {
  it("re-discovers with the new key and reports health recovered", async () => {
    const h = fixture();

    // Register it with the key the provider rejects.
    await h.client.mcp.servers.create(saveInput(OLD_KEY));
    const failed = await h.client.mcp.servers.test({ id: "server-1" });
    expect(failed.health.status).toBe("error");
    // The server's own reason is what is stored, not a substitute sentence.
    expect(failed.health.message).toContain("Invalid or revoked API key");
    expect(h.state.accepted).toEqual([]);

    // The person saves the key that works.
    const updated = await h.client.mcp.servers.update({
      id: "server-1",
      config: saveInput(NEW_KEY),
    });
    // The old verdict was about the old settings, so saving clears it.
    expect(updated.revision).toBe(2);
    expect(updated.health.status).not.toBe("ok");

    const afterSave = (await h.client.mcp.servers.list())[0]!;
    expect(["unknown", "installing"]).toContain(afterSave.health.status);

    // A check now re-discovers through the registered connection, with the new key.
    const recovered = await h.client.mcp.servers.test({ id: "server-1" });
    expect(recovered.health).toMatchObject({ status: "ok", toolCount: 1, message: null });
    expect(recovered.health.checkedAt).not.toBeNull();
    expect(h.state.accepted).toContain(`Bearer ${NEW_KEY}`);
    expect(h.state.accepted).not.toContain(`Bearer ${OLD_KEY}`);
    // The settings list agrees with the check: one server, one verdict.
    expect((await h.client.mcp.servers.list())[0]!.health).toMatchObject({
      status: "ok",
      toolCount: 1,
    });

    await h.connector.close();
    await h.store.close();
  });

  it("does not claim success when the new key is still rejected", async () => {
    const h = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Invalid or revoked API key", { status: 401 })),
    );

    await h.client.mcp.servers.create(saveInput(OLD_KEY));
    await h.client.mcp.servers.test({ id: "server-1" });
    const updated = await h.client.mcp.servers.update({
      id: "server-1",
      config: saveInput(`${NEW_KEY}-also-bad`),
    });
    expect(updated.health.status).not.toBe("ok");

    const checked = await h.client.mcp.servers.test({ id: "server-1" });
    expect(checked.health.status).toBe("error");
    expect(checked.health.message).toContain("Invalid or revoked API key");

    await h.connector.close();
    await h.store.close();
  });
});
