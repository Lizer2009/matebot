import { randomUUID } from "node:crypto";
import type { ManagedConnectorProvider } from "@matebot/adapter-kit";
import { ConnectorRegistry } from "@matebot/adapters";
import type { Actor } from "@matebot/contracts";
import { interactionCardKey } from "@matebot/core";
import type { PrismaClient } from "@matebot/db";
import { asSystem, createDb, getInteraction } from "@matebot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { markAppConnected } from "./onboarding.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

/**
 * The whole recovery loop, through the routes a client actually calls.
 *
 * Every other recovery test stops short of this. The unit tests assert that the right calls
 * were made against a stub; the Postgres suite calls `resumeInteractionAfterConnection`
 * directly. Neither can show what a person sees: they press Connect in the card, finish the
 * provider's page, and the same card on screen becomes editable again.
 *
 * So this file goes through `connections.begin`, `connections.complete` and
 * `connections.catalog` — the real handlers, the real advisory locks, the real provider
 * transaction gate, the real database — with one substitute: the connector, which stands in for
 * the mailbox service. No network, no credentials, no real OAuth.
 */

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

/**
 * A mailbox provider that answers from memory.
 *
 * It models what the connector contract actually distinguishes for browser OAuth, which is the
 * flow this card uses: `begin` sends the person to the provider's page and returns immediately;
 * the account starts existing remotely when they finish there; `complete` is a poll that asks
 * `connectionReady` whether it does. An explicit `code` is the other flow, and it is modelled
 * too, because the route branches on it.
 *
 * `finishInBrowser` and `abandonInBrowser` stand in for the person on the provider's page. They
 * are the only two things a test drives by hand — everything after them goes through the real
 * routes.
 */
function mailboxProvider() {
  const state = {
    /** Whether the provider has an account it would report as live. */
    live: false,
    /** Refs the provider says are dead and need authorizing again. */
    reconnectRefs: [] as string[],
    /** Authorization requests the provider still considers open. */
    openRequests: new Set<string>(),
    calls: { begin: 0, complete: 0, catalog: 0, revoke: 0 },
    /** Every tool call, so a test can prove nothing sent mail. */
    executed: [] as unknown[],
  };
  const provider = {
    describe: () => ({
      id: "composio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    }),
    catalog: async () => {
      state.calls.catalog += 1;
      return [
        {
          connectorId: "composio",
          slug: "gmail",
          name: "Gmail",
          logo: null,
          connected: state.live,
          noAuth: false,
        },
      ];
    },
    listConnectedExternalIds: async () => (state.live ? ["acct-live"] : []),
    listReconnectRefs: async () => [...state.reconnectRefs],
    begin: async () => {
      state.calls.begin += 1;
      const requestId = `request-${state.calls.begin}`;
      state.openRequests.add(requestId);
      // A browser authorization: the person is sent elsewhere and `complete` polls.
      return { state: requestId, authorizationUrl: "https://provider.test/authorize" };
    },
    complete: async () => {
      state.calls.complete += 1;
      state.live = true;
      return { connectionRef: "acct-live" };
    },
    revoke: async () => {
      state.calls.revoke += 1;
      state.live = false;
    },
    connectionReady: async () => state.live,
    resolveConnectedAccountId: async () => (state.live ? "acct-live" : undefined),
    cancelAuthorizationRequest: async (requestId: string) => {
      state.openRequests.delete(requestId);
    },
    discoverTools: async () => [],
    execute: (call: unknown) => {
      state.executed.push(call);
      return (async function* () {})();
    },
  } as unknown as ManagedConnectorProvider;
  const finishInBrowser = () => {
    state.live = true;
    state.openRequests.clear();
  };
  const abandonInBrowser = () => {
    // The person closed the provider's page: no account, and the request stays open until the
    // route cleans it up.
    state.live = false;
  };
  return { provider, state, finishInBrowser, abandonInBrowser };
}

describePostgres("card recovery through the real connection routes", () => {
  const stamp = randomUUID();
  /**
   * This file's own id prefix.
   *
   * Two suites in one database would otherwise delete each other's rows: `afterAll` removes by
   * prefix, and generic prefixes like `space-` are shared. The CI harness gives each file its own
   * database copy, but a plain `VERIFY_DATABASE=1 vitest run apps/api/src` does not.
   */
  const P = `connrec-${stamp}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let spaceId: string;
  let userId: string;
  let botId: string;
  let threadId: string;
  let messageId: string;
  let interactionId: string;
  let surfaceId: string;
  let orgId: string;

  const actor = (): Actor => ({
    spaceId,
    userId,
    email: "verify@example.test",
    isDeploymentOwner: true,
  });

  function deps(mailbox: ManagedConnectorProvider, enqueued: unknown[] = []): RouterDeps {
    return {
      prisma: system,
      jobs: {
        enqueue: async (job: unknown) => {
          enqueued.push(job);
        },
        cancel: async () => undefined,
      },
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
      dataDir: `/tmp/matebot-recovery-${stamp}`,
      connectors: new ConnectorRegistry([mailbox]),
    } as unknown as RouterDeps;
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
      { prefix: "/rpc", context: { actor: actor() } },
    );
    if (!response) throw new Error(`no response for ${path}`);
    return { status: response.status, json: await response.json() };
  }

  beforeEach(async () => {
    spaceId = `${P}-space-${randomUUID()}`;
    userId = `${P}-user-${randomUUID()}`;
    botId = `${P}-bot-${randomUUID()}`;
    threadId = `${P}-thread-${randomUUID()}`;
    messageId = `${P}-msg-${randomUUID()}`;
    interactionId = `${P}-ix-${randomUUID()}`;
    surfaceId = `${P}-surf-${randomUUID()}`;
    // Own organization per case, and a prefix that belongs only to this file (see P).
    const orgIdGenerated = `${P}-org-${randomUUID()}`;
    const organization = await system.organization.create({
      data: {
        id: orgIdGenerated,
        name: orgIdGenerated,
        slug: orgIdGenerated,
        createdAt: new Date(),
      },
    });
    orgId = organization.id;
    await system.space.create({
      data: { id: spaceId, organizationId: orgId, name: "space" },
    });
    await system.bot.create({
      data: { id: botId, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    await system.thread.create({ data: { id: threadId, spaceId, userId, botId } });
    // The card as the person left it: waiting for a mailbox, with their own subject typed and
    // the body still empty. Recovery may change its status and nothing else.
    await system.message.create({
      data: {
        id: messageId,
        threadId,
        seq: 0,
        role: "bot",
        botId,
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId,
            surfaceId,
            protocolFamily: "v0_9",
            draftVersion: 2,
            intent: "email.compose",
            capability: "not_connected",
            template: "email-connection-card",
            lifecycle: "draft",
          },
        ] as never,
      },
    });
    await system.interaction.create({
      data: {
        id: interactionId,
        spaceId,
        threadId,
        messageId,
        intent: "email.compose",
        cardKey: interactionCardKey(threadId, "email.compose"),
        status: "needs_connection",
        draftVersion: 2,
        plan: {
          intent: "email.compose",
          title: "冬天的问候",
          fields: [
            {
              name: "to",
              value: "alex@example.test",
              required: true,
              status: "resolved",
              source: "user",
            },
            {
              name: "subject",
              value: "我写的主题",
              required: true,
              status: "resolved",
              source: "user",
            },
            { name: "body", required: true, status: "missing" },
          ],
          nextStep: "render",
          riskLevel: "medium",
        } as never,
        slots: { to: "alex@example.test", subject: "我写的主题" } as never,
      },
    });
    await system.interactionSurface.create({
      data: {
        interactionId,
        surfaceId,
        protocolFamily: "v0_9",
        document: [] as never,
        draftVersion: 2,
      },
    });
  });

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    process.env.FEATURE_A2UI = "1";
  });

  afterAll(async () => {
    if (!db) return;
    await system.interaction.deleteMany({ where: { spaceId: { startsWith: P } } });
    await system.message.deleteMany({ where: { threadId: { startsWith: P } } });
    await system.connection.deleteMany({ where: { spaceId: { startsWith: P } } });
    await system.thread.deleteMany({ where: { spaceId: { startsWith: P } } });
    await system.bot.deleteMany({ where: { spaceId: { startsWith: P } } });
    await system.space.deleteMany({ where: { id: { startsWith: P } } });
    await system.organization.deleteMany({ where: { id: { startsWith: `${P}-org` } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  /** What the card on screen now says, read from the message row. */
  async function cardBlock() {
    const message = await system.message.findUnique({ where: { id: messageId } });
    const [block] = (message?.blocks ?? []) as Array<Record<string, unknown>>;
    return block;
  }

  async function draft() {
    const row = await getInteraction(system, interactionId);
    if (!row) throw new Error("interaction missing");
    return row;
  }

  /**
   * Everything that must be true of a recovered card, in one place.
   *
   * Every recovery case calls this, because "the card came back" is not the whole claim: the
   * person's values, their provenance and the draft version have to be exactly as they were, the
   * card must still be the same surface, and nothing may have been confirmed or sent.
   */
  async function expectRecovered(input: { draftVersion?: number } = {}) {
    const block = await cardBlock();
    expect(block).toMatchObject({ capability: "ready", template: "email-draft-card" });
    // Same card: the block the person is looking at still points at this interaction and surface.
    expect(block?.interactionId).toBe(interactionId);
    expect(block?.surfaceId).toBe(surfaceId);

    const row = await draft();
    expect(row.status).toBe("collecting");
    expect(row.draftVersion).toBe(input.draftVersion ?? 2);
    expect(row.confirmedVersion).toBeNull();
    expect(row.slots).toMatchObject({ to: "alex@example.test", subject: "我写的主题" });
    const plan = row.plan as { fields: Array<{ name: string; source?: string }> };
    expect(
      plan.fields.filter((field) => field.source === "user").map((field) => field.name),
    ).toEqual(["to", "subject"]);
    // No effect row: the table the send path writes is still empty.
    expect(await system.externalEffect.findMany({ where: { spaceId } })).toEqual([]);
    return row;
  }

  it("missing → begin → complete: the same card becomes editable and nothing is sent", async () => {
    const { provider, state, finishInBrowser } = mailboxProvider();
    const enqueued: unknown[] = [];
    const handler = new RPCHandler(createRouter(deps(provider, enqueued)));

    // The card is waiting on a mailbox that does not exist yet.
    expect((await cardBlock())?.capability).toBe("not_connected");

    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    expect(begun.status).toBe(200);
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    expect(connectionId).toBeTruthy();

    // The person finishes on the provider's page, and the client keeps polling complete.
    finishInBrowser();
    const completed = await rpc(handler, "connections/complete", { connectionId });
    expect(completed.status).toBe(200);
    expect((completed.json as { json: { status: string } }).json.status).toBe("connected");

    // The card behind the dialog, in the same message, is usable again.
    await expectRecovered();
    expect(await cardBlock()).toMatchObject({ lifecycle: "draft" });
    const row = await draft();
    expect((row.slots as Record<string, unknown>).body).toBeUndefined();
    // Nothing ran the mailbox: no tool call, no effect row, no model turn behind the card.
    // The effect table is the database-level check — recovery cannot write one even if it tried,
    // because nothing here calls the send path that creates it.
    expect(state.executed).toEqual([]);
    expect(await system.externalEffect.findMany({ where: { spaceId } })).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("does not start a model turn when the thread's card waits on another app", async () => {
    // A calendar card is what is outstanding; connecting the mailbox is not its business, and
    // the chat is not idle. The mailbox must really connect here: if it does not, `complete`
    // returns before the resume path and this case would pass without testing anything.
    await system.interaction.update({
      where: { id: interactionId },
      data: {
        intent: "calendar.create",
        plan: {
          intent: "calendar.create",
          title: "Create calendar",
          fields: [{ name: "name", required: true, status: "missing" }],
          nextStep: "ask",
          riskLevel: "medium",
        } as never,
      },
    });
    const { provider, finishInBrowser } = mailboxProvider();
    const enqueued: unknown[] = [];
    const handler = new RPCHandler(createRouter(deps(provider, enqueued)));

    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    finishInBrowser();
    const completed = await rpc(handler, "connections/complete", { connectionId });
    // The mailbox itself did connect; only the model turn is withheld.
    expect((completed.json as { json: { status: string } }).json.status).toBe("connected");

    expect(enqueued).toEqual([]);
    const row = await draft();
    expect(row.status).toBe("needs_connection");
    expect(row.draftVersion).toBe(2);
  });

  it("revoked → begin again → complete: the card recovers without a stale state", async () => {
    const { provider, state } = mailboxProvider();
    const handler = new RPCHandler(createRouter(deps(provider)));

    const first = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (first.json as { json: { connectionId: string } }).json.connectionId;
    state.live = true;
    await rpc(handler, "connections/complete", { connectionId });
    expect((await cardBlock())?.capability).toBe("ready");

    // The person removes the mailbox; the provider reports the account dead.
    state.live = false;
    const revoked = await rpc(handler, "connections/revoke", { connectionId });
    expect(revoked.status).toBe(200);
    expect(state.calls.revoke).toBe(1);

    // Revoking a mailbox does not put this card back into "waiting" by itself, and a test that
    // forgot that would be reading the leftover "ready" from the first connect. Put the draft
    // back in the state a person would see after the next attempt fails preflight, so the
    // reconnect below is the thing that has to recover it.
    await system.interaction.update({
      where: { id: interactionId },
      data: { status: "needs_connection", confirmedVersion: null },
    });
    await system.message.update({
      where: { id: messageId },
      data: {
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId,
            surfaceId,
            protocolFamily: "v0_9",
            draftVersion: 2,
            intent: "email.compose",
            capability: "not_connected",
            template: "email-connection-card",
            lifecycle: "draft",
          },
        ] as never,
      },
    });
    expect(await cardBlock()).toMatchObject({ capability: "not_connected" });
    expect((await draft()).status).toBe("needs_connection");

    // Authorizing again reuses the revoked row rather than piling up a second one.
    const again = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const secondId = (again.json as { json: { connectionId: string } }).json.connectionId;
    expect(secondId).toBe(connectionId);
    state.live = true;
    await rpc(handler, "connections/complete", { connectionId: secondId });

    const rows = await system.connection.findMany({ where: { spaceId, userId } });
    expect(rows.filter((row) => row.provider === "gmail")).toHaveLength(1);
    expect(rows[0]?.status).toBe("connected");
    // The reconnect is what recovered the card, and the draft is still only a draft.
    await expectRecovered();
  });

  it("reauth: a dead local row is reported as needing authorization, then recovers", async () => {
    // A row that still says connected while the provider says the account is gone. This is the
    // state that produced "Connected" on the card and a refusal on send.
    await system.connection.create({
      data: {
        id: `conn-${randomUUID()}`,
        spaceId,
        userId,
        connectorId: "composio",
        provider: "gmail",
        displayName: "Gmail",
        status: "connected",
        providerRef: "acct-dead",
      },
    });
    const { provider, state } = mailboxProvider();
    state.live = false;
    state.reconnectRefs = ["acct-dead"];
    const handler = new RPCHandler(createRouter(deps(provider)));

    // The catalog is what the client reads, and reconciling it marks the dead row.
    await rpc(handler, "connections/catalog", { query: "gmail" });
    const afterReconcile = await system.connection.findMany({ where: { spaceId, userId } });
    expect(afterReconcile[0]?.status).toBe("error");

    // Reauthorizing and completing the new authorization puts the same card back in order.
    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    // The person authorizes the same account again, so the provider now reports it usable.
    state.live = true;
    state.reconnectRefs = [];
    const completed = await rpc(handler, "connections/complete", { connectionId });
    expect(completed.status).toBe(200);
    await expectRecovered();
  });

  it("abandoned authorization: the card stays waiting, holding the person's text", async () => {
    const { provider, abandonInBrowser } = mailboxProvider();
    const handler = new RPCHandler(createRouter(deps(provider)));

    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    // The person closes the provider's page without authorizing. Polling complete finds no
    // account, so it reports the row as it stands rather than inventing a mailbox.
    abandonInBrowser();
    const completed = await rpc(handler, "connections/complete", { connectionId });
    expect(completed.status).toBe(200);
    expect((completed.json as { json: { status: string } }).json.status).toBe("pending");

    // The card is exactly as it was: still asking for a mailbox, still holding their text.
    expect(await cardBlock()).toMatchObject({ capability: "not_connected" });
    const row = await draft();
    expect(row.status).toBe("needs_connection");
    expect(row.draftVersion).toBe(2);
    expect(row.confirmedVersion).toBeNull();
    expect(row.slots).toMatchObject({ subject: "我写的主题" });
    // And no card was resumed by a half-finished authorization: the row is still pending, so it
    // is not a mailbox anything could act on.
    const rows = await system.connection.findMany({ where: { spaceId, userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("catalog reconcile resumes the waiting card too, not only the inline complete", async () => {
    // A person may finish authorizing in another tab; the catalog call is what notices. The card
    // still has to come back, or it says "Not connected" until something else refreshes it.
    await system.connection.create({
      data: {
        id: `conn-${randomUUID()}`,
        spaceId,
        userId,
        connectorId: "composio",
        provider: "gmail",
        displayName: "Gmail",
        status: "pending",
        providerRef: null,
      },
    });
    const { provider, state } = mailboxProvider();
    // The provider already knows the account: reconciliation will mark the row connected.
    state.live = true;
    const handler = new RPCHandler(createRouter(deps(provider)));

    await rpc(handler, "connections/catalog", { query: "gmail" });

    const rows = await system.connection.findMany({ where: { spaceId, userId } });
    expect(rows[0]?.status).toBe("connected");
    await expectRecovered();
  });

  it("resumes only the connecting person's card, never another member's in the same space", async () => {
    // Two people in one space, each with a waiting email card, each own bot and thread. When the
    // first authorizes their mailbox, the second person's card must not move: a space-wide sweep
    // would either rewrite their card or start a turn in their chat.
    const otherUserId = `user-${randomUUID()}`;
    const otherBotId = `bot-${randomUUID()}`;
    const otherThreadId = `thread-${randomUUID()}`;
    const otherMessageId = `msg-${randomUUID()}`;
    const otherInteractionId = `ix-${randomUUID()}`;
    await system.bot.create({
      data: { id: otherBotId, spaceId, userId: otherUserId, name: "Matebot 2", color: "#3b82f6" },
    });
    await system.thread.create({
      data: { id: otherThreadId, spaceId, userId: otherUserId, botId: otherBotId },
    });
    await system.message.create({
      data: {
        id: otherMessageId,
        threadId: otherThreadId,
        seq: 0,
        role: "bot",
        botId: otherBotId,
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: otherInteractionId,
            surfaceId: `surf-${otherInteractionId}`,
            protocolFamily: "v0_9",
            draftVersion: 1,
            intent: "email.compose",
            capability: "not_connected",
            template: "email-connection-card",
            lifecycle: "draft",
          },
        ] as never,
      },
    });
    await system.interaction.create({
      data: {
        id: otherInteractionId,
        spaceId,
        threadId: otherThreadId,
        messageId: otherMessageId,
        intent: "email.compose",
        cardKey: interactionCardKey(otherThreadId, "email.compose"),
        status: "needs_connection",
        draftVersion: 1,
        plan: {
          intent: "email.compose",
          title: "他们的草稿",
          fields: [
            { name: "to", value: "them@example.test", required: true, status: "resolved" },
            { name: "subject", value: "他们的主题", required: true, status: "resolved" },
            { name: "body", required: true, status: "missing" },
          ],
          nextStep: "render",
          riskLevel: "medium",
        } as never,
        slots: { to: "them@example.test", subject: "他们的主题" } as never,
      },
    });
    // A surface row is what the resume loop rewrites, so without one this case would pass for
    // the wrong reason — the card would be skipped before anyone had to decide whose it is.
    await system.interactionSurface.create({
      data: {
        interactionId: otherInteractionId,
        surfaceId: `surf-${otherInteractionId}`,
        protocolFamily: "v0_9",
        document: [] as never,
        draftVersion: 1,
      },
    });

    const { provider, state } = mailboxProvider();
    state.live = true;
    const handler = new RPCHandler(createRouter(deps(provider)));

    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    await rpc(handler, "connections/complete", { connectionId });

    // The connecting person's card recovered.
    expect(await cardBlock()).toMatchObject({ capability: "ready" });
    // The other person's is untouched: same status, same block, same text.
    const theirs = await getInteraction(system, otherInteractionId);
    expect(theirs?.status).toBe("needs_connection");
    expect(theirs?.slots).toMatchObject({ subject: "他们的主题" });
    const theirMessage = await system.message.findUnique({ where: { id: otherMessageId } });
    if (!theirMessage) throw new Error("their message missing");
    const [theirBlock] = theirMessage.blocks as Array<Record<string, unknown>>;
    expect(theirBlock).toMatchObject({ capability: "not_connected" });

    await system.interaction.deleteMany({ where: { id: otherInteractionId } });
    await system.message.deleteMany({ where: { id: otherMessageId } });
    await system.thread.deleteMany({ where: { id: otherThreadId } });
    await system.bot.deleteMany({ where: { id: otherBotId } });
  });

  it("onboarding markAppConnected resumes the same card on its own thread", async () => {
    const { provider, state } = mailboxProvider();
    state.live = true;
    const depsForOnboarding = deps(provider);
    await markAppConnected(
      {
        prisma: system,
        events: (depsForOnboarding as unknown as { events: never }).events,
        connectors: new ConnectorRegistry([provider]),
      },
      actor(),
      botId,
      "gmail",
      "composio",
      threadId,
    );

    await expectRecovered();
  });

  it("does not pull an already-confirmed draft back to collecting", async () => {
    // Two layers protect this: the route only looks for cards that are waiting, and the refresh
    // itself only touches `needs_connection`. This case calls the resume directly, so it is the
    // inner guard being tested — the route-level case below covers the outer one.
    const { resumeInteractionAfterConnection } = await import("./interaction-resume.js");
    await system.interaction.update({
      where: { id: interactionId },
      data: { status: "awaiting_approval", confirmedVersion: 2 },
    });

    const result = await resumeInteractionAfterConnection(
      { prisma: system },
      { actor: { spaceId, userId }, botId, threadId, provider: "gmail", appConnected: true },
    );
    // Nothing was waiting on this app, and no turn is started over an approved draft.
    expect(result.refreshedInteractionIds).toEqual([]);
    const row = await draft();
    expect(row.status).toBe("awaiting_approval");
    expect(row.confirmedVersion).toBe(2);
  });

  it("does not revive a cancelled card", async () => {
    const { resumeInteractionAfterConnection } = await import("./interaction-resume.js");
    await system.interaction.update({
      where: { id: interactionId },
      data: { status: "cancelled" },
    });

    const result = await resumeInteractionAfterConnection(
      { prisma: system },
      { actor: { spaceId, userId }, botId, threadId, provider: "gmail", appConnected: true },
    );
    expect(result.refreshedInteractionIds).toEqual([]);
    expect((await draft()).status).toBe("cancelled");
    expect(await cardBlock()).toMatchObject({ capability: "not_connected" });
  });

  it("does not revive an already-run card when its mailbox connects", async () => {
    // The route-level version of the same guarantee: a card that succeeded stays as it is.
    await system.interaction.update({
      where: { id: interactionId },
      data: { status: "succeeded" },
    });
    const { provider, finishInBrowser } = mailboxProvider();
    const handler = new RPCHandler(createRouter(deps(provider)));
    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    finishInBrowser();
    await rpc(handler, "connections/complete", { connectionId });

    const row = await draft();
    expect(row.status).toBe("succeeded");
  });

  it("leaves a card in another space alone, even when the thread is the one resuming", async () => {
    // The refresh query takes the space and the thread together. A card in a different space is
    // not this person's, whatever its thread id says.
    const otherSpaceId = `space-${randomUUID()}`;
    const otherOrgId = `org-${otherSpaceId}`;
    const otherThreadId = `thread-${randomUUID()}`;
    const otherInteractionId = `ix-${randomUUID()}`;
    const otherBotId = `bot-${randomUUID()}`;
    await system.organization.create({
      data: { id: otherOrgId, name: otherOrgId, slug: otherOrgId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: otherSpaceId, organizationId: otherOrgId, name: "other" },
    });
    await system.bot.create({
      data: { id: otherBotId, spaceId: otherSpaceId, userId, name: "Other", color: "#111111" },
    });
    await system.thread.create({
      data: { id: otherThreadId, spaceId: otherSpaceId, userId, botId: otherBotId },
    });
    await system.interaction.create({
      data: {
        id: otherInteractionId,
        spaceId: otherSpaceId,
        threadId: otherThreadId,
        intent: "email.compose",
        cardKey: interactionCardKey(otherThreadId, "email.compose"),
        status: "needs_connection",
        draftVersion: 1,
        plan: {
          intent: "email.compose",
          title: "别处",
          fields: [{ name: "subject", value: "别处的主题", required: true, status: "resolved" }],
          nextStep: "render",
          riskLevel: "medium",
        } as never,
        slots: { subject: "别处的主题" } as never,
      },
    });

    const { provider, finishInBrowser } = mailboxProvider();
    const handler = new RPCHandler(createRouter(deps(provider)));
    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    finishInBrowser();
    await rpc(handler, "connections/complete", { connectionId });

    // This person's card in this space recovered; the other space's did not move.
    await expectRecovered();
    const theirs = await getInteraction(system, otherInteractionId);
    expect(theirs?.status).toBe("needs_connection");

    await system.interaction.deleteMany({ where: { id: otherInteractionId } });
    await system.thread.deleteMany({ where: { id: otherThreadId } });
    await system.bot.deleteMany({ where: { id: otherBotId } });
    await system.space.deleteMany({ where: { id: otherSpaceId } });
    await system.organization.deleteMany({ where: { id: otherOrgId } });
  });

  it("leaves the card untouched when the authorization is refused by the provider", async () => {
    // `begin` failing is the other way a connection does not happen. The row is marked error and
    // the card keeps its values; nothing is resumed off a half-finished authorization.
    const { provider, state } = mailboxProvider();
    const handler = new RPCHandler(createRouter(deps(provider)));
    const refused = new RPCHandler(
      createRouter(
        deps({
          ...provider,
          begin: async () => {
            state.calls.begin += 1;
            throw new Error("provider refused the authorization");
          },
        } as unknown as ManagedConnectorProvider),
      ),
    );

    const response = await rpc(refused, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    expect(response.status).not.toBe(200);

    // The card is exactly as it was, and the failed row did not become a usable mailbox.
    const row = await draft();
    expect(row.status).toBe("needs_connection");
    expect(row.draftVersion).toBe(2);
    expect(row.slots).toMatchObject({ subject: "我写的主题" });
    expect(await cardBlock()).toMatchObject({ capability: "not_connected" });
    const rows = await system.connection.findMany({ where: { spaceId, userId } });
    expect(rows.every((entry) => entry.status !== "connected")).toBe(true);
    void handler;
  });

  it("does not refresh a card when the space and the thread disagree", async () => {
    // `refreshWaitingInteractions` takes the space and the thread together. Thread ids are
    // unique, so this needs a deliberately mismatched call to observe — which is the point:
    // the query must not trust its caller to have matched them.
    const { resumeInteractionAfterConnection } = await import("./interaction-resume.js");
    const elsewhere = `space-${randomUUID()}`;
    const result = await resumeInteractionAfterConnection(
      { prisma: system },
      {
        actor: { spaceId: elsewhere, userId },
        botId,
        threadId,
        provider: "gmail",
        appConnected: true,
      },
    );
    expect(result.refreshedInteractionIds).toEqual([]);
    // The card in its real space was not touched by a call that named another one.
    expect(await cardBlock()).toMatchObject({ capability: "not_connected" });
    expect((await draft()).status).toBe("needs_connection");
  });

  it("keeps the card intact when the resume itself fails", async () => {
    // Both resume callers swallow the error and log a warning, on the claim that the card simply
    // stays as it is. That claim is what this pins: a broken resume must not corrupt the draft,
    // and must not leave it half-moved.
    const { provider, finishInBrowser } = mailboxProvider();
    const handler = new RPCHandler(createRouter(deps(provider)));

    const begun = await rpc(handler, "connections/begin", {
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
    });
    const connectionId = (begun.json as { json: { connectionId: string } }).json.connectionId;
    finishInBrowser();

    // The resume's own reads are what fail. Only the queries that look for waiting cards throw,
    // so the connection itself still settles and the failure lands where the catch expects it.
    const real = system.interaction.findMany.bind(system.interaction);
    const spy = vi.spyOn(system.interaction, "findMany").mockImplementation((async (args: {
      where?: { status?: unknown };
    }) => {
      if (args?.where?.status === "needs_connection") throw new Error("resume read failed");
      return real(args as never);
    }) as never);

    const completed = await rpc(handler, "connections/complete", { connectionId });
    // The mailbox still connected; only the resume failed.
    expect(completed.status).toBe(200);
    expect((completed.json as { json: { status: string } }).json.status).toBe("connected");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const row = await draft();
    expect(row.status).toBe("needs_connection");
    expect(row.draftVersion).toBe(2);
    expect(row.slots).toMatchObject({ to: "alex@example.test", subject: "我写的主题" });
    expect(row.confirmedVersion).toBeNull();
    expect(await system.externalEffect.findMany({ where: { spaceId } })).toEqual([]);
  });
});
