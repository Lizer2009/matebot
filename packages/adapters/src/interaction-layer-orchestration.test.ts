import type { InteractionPlan } from "@matebot/contracts";
import { vi } from "vitest";

// The event row is not what this test is about, and appending one needs a whole run/lease
// lifecycle. The card write below is the real one.
vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    appendEventInTransaction: vi.fn(async () => ({ id: "event-1", seq: 1 })),
  };
});

import { compileInteractionPlan } from "@matebot/a2ui-adapter";
import { interactionCapabilityForIntent, LAYER_DISCIPLINE_PROMPT } from "@matebot/core";
import { describe, expect, it } from "vitest";
import { connectApp } from "./connect-app.js";
import { annotateConnectorCall, annotateWebEntry } from "./route-annotation.js";

/**
 * One conversation crossing the layers, in the order a person actually goes.
 *
 * Each step here uses the production entry point for that layer — the page opener's annotation,
 * the real `connectApp` service with a fake provider catalog, the real surface compiler — rather
 * than the classifier alone. The invariant under test is the one the prompt states: a later layer
 * is only claimed when its own evidence exists, so the same conversation can walk from "I opened
 * the page" to "you have a draft" without ever claiming the last thing before it is true.
 *
 * No network, no provider, no model. The "provider" is an in-memory catalog, so "connected" is a
 * fact this test created rather than a claim it trusts.
 */

type CatalogEntry = {
  connectorId: string;
  slug: string;
  name: string;
  logo: null;
  connected: boolean;
  noAuth: boolean;
};

function fakeAppCatalog(connectedSlug: string | null) {
  const entries: CatalogEntry[] = [
    {
      connectorId: "composio",
      slug: "gmail",
      name: "Gmail",
      logo: null,
      connected: connectedSlug === "gmail",
      noAuth: false,
    },
  ];
  return {
    entries,
    providers: [
      {
        describe: () => ({ id: "composio" }),
        catalog: async () => entries,
      },
    ] as never,
  };
}

/** The smallest store `connectApp` needs, so a card can be written and read back. */
function fakeThread() {
  const written: Array<{ blocks: unknown[] }> = [];
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    $executeRaw: async () => undefined,
    // The write path checks the run may still write history before it inserts.
    run: {
      findUnique: async () => ({
        id: "run-1",
        status: "running",
        leaseOwner: null,
        firstResponseAt: null,
        spaceId: "space-1",
        threadId: "thread-1",
      }),
      findFirst: async () => ({ id: "run-1", status: "running" }),
    },
    event: { create: async () => ({ id: "event-1", seq: written.length + 1 }) },
    // `createThreadMessageInTransaction` bumps the thread's sequence first.
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
    },
  } as never;
  const events = {
    append: async () => ({ id: "e", seq: written.length }),
    notify: async () => undefined,
  } as never;
  return { prisma, events, written };
}

const context = {
  operationId: "op",
  traceId: "op",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const target = { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" };

describe("a conversation crosses the layers in order", () => {
  it("says a page was opened, then that the app is only offered, then that it is connected", async () => {
    // 1. "open the page" — L1, and nothing more.
    const opened = annotateWebEntry("https://docs.example.test/document/1");
    expect(opened.route).toMatchObject({ layer: "web", connected: false, executed: false });
    expect(opened.routeNotice).toContain("没有连接任何应用");

    // 2. "connect Gmail" with nothing connected yet — L2, a card is offered. Still not connected.
    const first = fakeThread();
    const catalog = fakeAppCatalog(null);
    const offered = (await connectApp(
      { prisma: first.prisma, events: first.events },
      catalog.providers,
      context,
      target,
      "gmail",
      "effect-1",
    )) as Record<string, unknown>;
    expect(offered.status).toBe("pending");
    expect(offered.route).toMatchObject({ connected: false, executed: false });
    // A card was actually written; "offered" is not just a word in a return value.
    expect(first.written).toHaveLength(1);

    // 3. The same request after the person authorized — L3, connected, still nothing run.
    const second = fakeThread();
    const authorized = fakeAppCatalog("gmail");
    const connected = (await connectApp(
      { prisma: second.prisma, events: second.events },
      authorized.providers,
      context,
      target,
      "gmail",
      "effect-2",
    )) as Record<string, unknown>;
    expect(connected.status).toBe("connected");
    expect(connected.route).toMatchObject({ connected: true, executed: false });
    // No card is posted for an app that is already connected.
    expect(second.written).toHaveLength(0);
  });

  it("never lets a discovery result claim the execution a later call makes", async () => {
    // A search returns schemas. Even with an effect id in hand it stays discovered — the
    // classifier refuses to call it executed, and the annotation refuses to carry the id.
    const searched = annotateConnectorCall({
      tool: "COMPOSIO_SEARCH_TOOLS",
      effectId: "effect-search",
    });
    expect(searched.route).toMatchObject({ executed: false, effectId: null });
    // The classifier is what refuses it: called with an id, a search still reports none. That
    // is the whole defense, so it is asserted directly rather than through a second layer.
    const again = annotateConnectorCall({
      tool: "composio_search_tools",
      effectId: "effect-2",
    });
    expect(again.route).toMatchObject({ kind: "discovered", executed: false, effectId: null });

    // The call that actually ran has a ledger row, and only then is it reported as executed.
    const ran = annotateConnectorCall({ tool: "GMAIL_SEND_EMAIL", effectId: "effect-send" });
    expect(ran.route).toMatchObject({ executed: true, effectId: "effect-send" });
  });

  it("turns the last layer into a draft that is compiled but not run", async () => {
    // The card the conversation ends on. It exists, it is editable, and nothing about producing
    // it executes anything — the action waits for the person.
    const plan: InteractionPlan = {
      intent: "email.compose",
      title: "冬天的问候",
      fields: [
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "body", value: "正文", required: true, status: "resolved" },
      ],
      nextStep: "request_approval",
      riskLevel: "medium",
    };
    const compiled = await compileInteractionPlan({
      plan,
      surfaceId: "surf-1",
      schema: interactionCapabilityForIntent("email.compose")!.schema,
    });
    expect(compiled.ok).toBe(true);
    // The compiled document has controls, which is what makes it a draft rather than a result.
    const json = JSON.stringify(compiled.ok ? compiled.messages : []);
    expect(json).toContain("TextField");
  });
});

describe("the instruction and the results agree", () => {
  it("states the same boundaries the annotations enforce, in the same words", () => {
    // A model reading a result and a model reading its instructions must not be told two things.
    const page = annotateWebEntry("https://example.test");
    expect(page.routeNotice.length).toBeGreaterThan(0);
    expect(LAYER_DISCIPLINE_PROMPT).toContain(
      "Opening a page in the browser is not connecting an app",
    );
    // The annotation's own sentence says the same thing in the user's language.
    expect(page.routeNotice).toMatch(/没有连接任何应用/);
    expect(LAYER_DISCIPLINE_PROMPT).toContain("executed: false");
  });
});
