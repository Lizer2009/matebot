import { compileInteractionPlan } from "@matebot/a2ui-adapter";
import { interactionCapabilityForIntent, LAYER_DISCIPLINE_PROMPT } from "@matebot/core";
import { describe, expect, it, vi } from "vitest";

// The event row is not what this test is about; the tool results are.
vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    appendEventInTransaction: vi.fn(async () => ({ id: "event-1", seq: 1 })),
  };
});

import { connectApp } from "./connect-app.js";
import { annotateConnectorCall, annotateWebEntry } from "./route-annotation.js";
import { pageBrowserTool } from "./run-tools-computer.js";
import { connectorTool } from "./run-tools-integrations.js";

/**
 * One conversation crossing the layers, driven through the handlers that run in production.
 *
 * Every step calls the tool handler the runtime dispatches to — `pageBrowserTool`, `connectApp`,
 * `connectorTool` — not the annotation helpers. Deleting the annotation from any of those
 * handlers must fail this file; if it does not, the test is only describing the helpers to itself.
 *
 * No network, no provider, no model. The browser is a fake page store and the app catalog is an
 * in-memory list, so "connected" is a fact the test created rather than a claim it trusts.
 */

const context = {
  operationId: "op",
  traceId: "op",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const target = { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" };

/** A thread store the real `connectApp` can write a card into. */
function fakeThread() {
  const written: Array<{ blocks: unknown[] }> = [];
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    $executeRaw: async () => undefined,
    run: {
      findUnique: async () => ({
        id: "run-1",
        status: "running",
        leaseOwner: null,
        firstResponseAt: null,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    event: { create: async () => ({ id: "event-1", seq: written.length + 1 }) },
    thread: {
      update: async () => ({ nextMessageSeq: written.length + 1 }),
      findFirst: async () => ({ id: "thread-1", spaceId: "space-1" }),
    },
    message: {
      findFirst: async () => null,
      findMany: async () => written.map((entry) => ({ blocks: entry.blocks })),
      create: async ({ data }: { data: { blocks: unknown[] } }) => {
        written.push({ blocks: data.blocks });
        return { id: `msg-${written.length}` };
      },
      update: async ({ data }: { data: { blocks: unknown[] } }) => {
        if (written[0]) written[0].blocks = data.blocks;
        return { id: "msg-1" };
      },
      findUnique: async () => ({ blocks: written[0]?.blocks ?? [] }),
    },
    interaction: {
      findFirst: async () => null,
      findUnique: async () => ({ status: "needs_connection", draftVersion: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "ix-1",
        draftVersion: 1,
        title: data.title,
        summary: null,
        intent: data.intent,
        ...data,
      }),
      update: async () => ({ id: "ix-1" }),
      updateMany: async () => ({ count: 1 }),
    },
    interactionEvent: { create: async () => ({ id: "iev-1" }) },
  } as never;
  const events = {
    append: async () => ({ id: "e", seq: written.length }),
    notify: async () => undefined,
  } as never;
  return { prisma, events, written };
}

function appCatalog(connectedSlug: string | null) {
  const entries = [
    {
      connectorId: "composio",
      slug: "gmail",
      name: "Gmail",
      logo: null,
      connected: connectedSlug === "gmail",
      noAuth: false,
    },
  ];
  return [{ describe: () => ({ id: "composio" }), catalog: async () => entries }] as never;
}

/** The real page-browser handler, against a fake page store. */
async function openPage(url: string) {
  const browser = {
    navigate: async (_computer: unknown, request: { url: string }) => {
      if (!request.url.startsWith("https://")) {
        // What the production helper returns for a URL it refuses.
        return {
          ok: false,
          uncertain: false,
          error: "An HTTP(S) URL without embedded credentials is required",
        };
      }
      return { ok: true, url: request.url, title: "Doc", tree: "- heading", elements: [] };
    },
    snapshot: async () => ({ ok: true, url, title: "Doc", tree: "- heading", elements: [] }),
    act: async () => ({ ok: true }),
  };
  const ctx = {
    deps: { prisma: { taughtSkill: { findFirst: async () => null } } },
    run: { spaceId: "space-1", botId: "bot-1" },
    bot: { id: "bot-1" },
    context,
    computer: {
      heldForTakeover: false,
      graphicalToolsAllowed: false,
      mode: "private",
      checkpoint: { markDirty: () => {} },
      get: async () => ({ id: "c1", botId: "bot-1", kind: "fake", providerRef: "c1" }),
    },
    tools: { disabled: new Set<string>() },
    providers: { browser },
    secrets: new Set<string>(),
    state: { screen: { unchangedVisualStreak: { count: 0 } } },
  } as never;
  const call = { name: "browser_navigate", args: { url }, finish: async (r: unknown) => r };
  // The tool wraps its payload for the model: the marker travels in `details`, which is what
  // `browserResultForModel` serialises.
  const out = (await pageBrowserTool(ctx, call as never)) as {
    details?: Record<string, unknown>;
  };
  return (out.details ?? (out as Record<string, unknown>)) as Record<string, unknown>;
}

/** The real connector handler, with a fake connector that returns a payload. */
async function callConnector(tool: string, data: unknown, effect?: { id: string; status: string }) {
  const ctx = {
    deps: {
      connector: {
        execute: async function* () {
          yield { type: "result", data };
        },
      },
      events: { append: async () => undefined },
    },
    run: { id: "run-1", spaceId: "space-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    context,
  } as never;
  const call = {
    name: tool,
    args: {},
    effectKey: "key-1",
    connectorCall: { tool, args: {}, executionId: "exec-1" },
    applied: effect ? { effect } : undefined,
    finish: (r: unknown) => r,
  } as never;
  return (await connectorTool(ctx, call as never)) as Record<string, unknown>;
}

describe("a conversation crosses the layers through the handlers production uses", () => {
  it("says a page opened, and says it did not when the browser refused", async () => {
    const opened = await openPage("https://docs.example.test/document/1");
    expect(opened.route).toMatchObject({
      layer: "web",
      opened: true,
      connected: false,
      executed: false,
    });
    expect(String(opened.routeNotice)).toContain("This page was opened");

    // The same handler, on a URL the browser refuses. Not "opened".
    const refused = await openPage("ftp://files.example.test/x");
    expect(refused.route).toMatchObject({ layer: "web", opened: false });
    expect(String(refused.routeNotice)).toContain("This page was not opened");
  });

  it("says an app is only offered before authorization, and connected after", async () => {
    // Nothing connected: the real service writes a card and reports an offer.
    const first = fakeThread();
    const offered = (await connectApp(
      { prisma: first.prisma, events: first.events },
      appCatalog(null),
      context,
      target,
      "gmail",
      "effect-1",
    )) as Record<string, unknown>;
    expect(offered.route).toMatchObject({ layer: "catalog", connected: false, executed: false });
    expect(first.written).toHaveLength(1);

    // The same call after the person authorized: a connection, still nothing run.
    const second = fakeThread();
    const connected = (await connectApp(
      { prisma: second.prisma, events: second.events },
      appCatalog("gmail"),
      context,
      target,
      "gmail",
      "effect-2",
    )) as Record<string, unknown>;
    expect(connected.route).toMatchObject({
      layer: "connection",
      kind: "connected",
      connected: true,
      executed: false,
    });
    expect(second.written).toHaveLength(0);
  });

  it("reports a schema lookup as discovered even when an effect row exists", async () => {
    // The connector handler is what ran. A search returns schemas; an id in hand must not turn
    // it into an execution claim.
    const searched = await callConnector(
      "COMPOSIO_SEARCH_TOOLS",
      { tools: [{ slug: "GMAIL_SEND_EMAIL" }] },
      { id: "effect-search", status: "completed" },
    );
    expect(searched.route).toMatchObject({ layer: "tool", kind: "discovered", executed: false });
    expect((searched.route as { effectId: string | null }).effectId).toBeNull();
  });

  it("does not annotate an ordinary action's own payload", async () => {
    // A real action keeps the shape the rest of the product reads.
    const ran = await callConnector(
      "GMAIL_SEND_EMAIL",
      { messageId: "m-1" },
      { id: "effect-1", status: "completed" },
    );
    expect(ran).toEqual({ messageId: "m-1" });
  });

  it("turns the last layer into a draft that is compiled but not run", async () => {
    const plan = {
      intent: "email.compose" as const,
      title: "冬天的问候",
      fields: [
        { name: "to", value: "alex@example.test", required: true, status: "resolved" as const },
        { name: "subject", value: "s", required: true, status: "resolved" as const },
        { name: "body", value: "b", required: true, status: "resolved" as const },
      ],
      nextStep: "request_approval" as const,
      riskLevel: "medium" as const,
    };
    const compiled = await compileInteractionPlan({
      plan,
      surfaceId: "surf-1",
      schema: interactionCapabilityForIntent("email.compose")!.schema,
    });
    expect(compiled.ok).toBe(true);
    expect(JSON.stringify(compiled.ok ? compiled.messages : [])).toContain("TextField");
  });
});

describe("the instruction and the results agree", () => {
  it("states the boundaries the annotations enforce", () => {
    const page = annotateWebEntry("https://example.test");
    expect(LAYER_DISCIPLINE_PROMPT).toContain(
      "Opening a page in the browser is not connecting an app",
    );
    // The notice is one language; the prompt says to convey it rather than paste it.
    expect(LAYER_DISCIPLINE_PROMPT).toContain("routeNotice");
    expect(LAYER_DISCIPLINE_PROMPT).toMatch(/do not paste the English sentence/);
    expect(annotateConnectorCall({ tool: "COMPOSIO_SEARCH_TOOLS" }).route.executed).toBe(false);
    expect(page.route.executed).toBe(false);
  });
});
