import type { PrismaClient } from "@matebot/db";
import { describe, expect, it, vi } from "vitest";
import {
  gcStaleCards,
  gcStaleCardsForRun,
  markOpenCardsStale,
  settleStaleCards,
  settleStaleCardsForRun,
} from "./interaction-stale.js";

type Row = {
  id: string;
  status: string;
  staleAt: Date | null;
  messageId: string | null;
  intent: string;
  slots: Record<string, unknown>;
  spaceId: string;
  threadId: string;
};

function fakePrisma(rows: Row[]) {
  const store = rows.map((row) => ({ ...row }));
  const messages = new Map<string, { id: string; blocks: Record<string, unknown>[] }>();
  for (const row of store) {
    if (!row.messageId) continue;
    messages.set(row.messageId, {
      id: row.messageId,
      blocks: [
        {
          kind: "a2ui_surface",
          interactionId: row.id,
          surfaceId: `surf-${row.id}`,
          protocolFamily: "v0_9",
          draftVersion: 1,
          intent: row.intent,
          status: row.status,
          lifecycle: "draft",
          template: "email-draft-card",
        },
      ],
    });
  }

  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return store.filter((row) => matchRow(row, where));
  });
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    return store.find((row) => row.id === where.id) ?? null;
  });
  const updateMany = vi.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = store.filter((row) => matchRow(row, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    },
  );
  const messageFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    return messages.get(where.id) ?? null;
  });
  const messageUpdate = vi.fn(
    async ({ where, data }: { where: { id: string }; data: { blocks: unknown } }) => {
      const current = messages.get(where.id);
      if (!current) return null;
      current.blocks = data.blocks as Record<string, unknown>[];
      return current;
    },
  );

  return {
    store,
    messages,
    updateMany,
    messageUpdate,
    prisma: {
      interaction: { findMany, findUnique, updateMany },
      message: { findUnique: messageFindUnique, update: messageUpdate },
      interactionEvent: { create: vi.fn().mockResolvedValue({ id: "ev-1" }) },
    } as unknown as PrismaClient,
  };
}

function matchRow(row: Row, where: Record<string, unknown>): boolean {
  if (where.id && row.id !== where.id) return false;
  if (where.threadId && row.threadId !== where.threadId) return false;
  if (typeof where.status === "string" && row.status !== where.status) return false;
  if (
    where.status &&
    typeof where.status === "object" &&
    where.status !== null &&
    "in" in where.status
  ) {
    const allowed = (where.status as { in: string[] }).in;
    if (!allowed.includes(row.status)) return false;
  }
  if ("staleAt" in where) {
    const expected = where.staleAt;
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date) &&
      "lt" in expected
    ) {
      if (!row.staleAt || !(row.staleAt < (expected as { lt: Date }).lt)) return false;
    } else if (
      (row.staleAt?.getTime() ?? null) !== ((expected as Date | null)?.getTime() ?? null)
    ) {
      return false;
    }
  }
  return true;
}

const thread = "thread-1";
const mark = new Date("2026-11-14T00:00:00.000Z");

function openCard(id: string, extra?: Partial<Row>): Row {
  return {
    id,
    status: "ready_for_review",
    staleAt: null,
    messageId: `m-${id}`,
    intent: "email.compose",
    slots: { to: "example@example.test", subject: "产品发布" },
    spaceId: "space-1",
    threadId: thread,
    ...extra,
  };
}

describe("markOpenCardsStale", () => {
  it("writes staleAt on open cards and leaves status alone", async () => {
    const { prisma, store } = fakePrisma([
      openCard("open"),
      openCard("waiting", { status: "needs_connection" }),
      openCard("unknown", { status: "unknown" }),
    ]);
    const marked = await markOpenCardsStale(prisma, { threadId: thread, at: mark });
    expect(marked.marked).toEqual(["open"]);
    expect(store.find((row) => row.id === "open")).toMatchObject({
      status: "ready_for_review",
      staleAt: mark,
    });
    expect(store.find((row) => row.id === "waiting")?.staleAt).toBeNull();
    expect(store.find((row) => row.id === "unknown")?.staleAt).toBeNull();
  });

  it("stamps the live block stale without changing its kernel status", async () => {
    const { prisma, messages } = fakePrisma([openCard("open")]);
    await markOpenCardsStale(prisma, { threadId: thread, at: mark });
    expect(messages.get("m-open")?.blocks[0]).toMatchObject({
      status: "ready_for_review",
      stale: true,
    });
  });
});

describe("settleStaleCards", () => {
  it("hard-settles cards that still carry the snapshot mark and restamps the block", async () => {
    const { prisma, store, messages } = fakePrisma([openCard("open", { staleAt: mark })]);
    const settled = await settleStaleCards(prisma, {
      threadId: thread,
      staleAtSnapshot: mark,
      reason: "user_message",
    });
    expect(settled.settled).toEqual(["open"]);
    expect(store[0]).toMatchObject({ status: "superseded" });
    expect(messages.get("m-open")?.blocks[0]).toMatchObject({
      status: "superseded",
      template: "action-superseded-card",
    });
    expect(messages.get("m-open")?.blocks[0]?.stale).toBeUndefined();
  });

  it("leaves a card the person already sent", async () => {
    const { prisma, store } = fakePrisma([openCard("sent", { status: "sent", staleAt: mark })]);
    const settled = await settleStaleCards(prisma, {
      threadId: thread,
      staleAtSnapshot: mark,
      reason: "user_message",
    });
    expect(settled.settled).toEqual([]);
    expect(store[0]?.status).toBe("sent");
  });

  it("does not settle a card whose mark was cleared or replaced", async () => {
    const later = new Date("2026-11-14T00:01:00.000Z");
    const { prisma, store } = fakePrisma([
      openCard("cleared", { staleAt: null }),
      openCard("newer", { staleAt: later }),
    ]);
    const settled = await settleStaleCards(prisma, {
      threadId: thread,
      staleAtSnapshot: mark,
      reason: "user_message",
    });
    expect(settled.settled).toEqual([]);
    expect(store.map((row) => row.status)).toEqual(["ready_for_review", "ready_for_review"]);
  });
});

describe("gcStaleCards", () => {
  it("settles leftover marks older than this run", async () => {
    const runStart = new Date("2026-11-14T00:05:00.000Z");
    const leftover = new Date("2026-11-14T00:00:00.000Z");
    const { prisma, store } = fakePrisma([
      openCard("old", { staleAt: leftover }),
      openCard("fresh", { staleAt: runStart }),
    ]);
    const settled = await gcStaleCards(prisma, { threadId: thread, before: runStart });
    expect(settled.settled).toEqual(["old"]);
    expect(store.find((row) => row.id === "old")?.status).toBe("superseded");
    expect(store.find((row) => row.id === "fresh")?.status).toBe("ready_for_review");
  });
});

describe("run hooks", () => {
  it("skips routine runs so a wakeup does not close a draft", async () => {
    const { prisma, store } = fakePrisma([openCard("open", { staleAt: mark })]);
    await gcStaleCardsForRun(prisma, {
      threadId: thread,
      createdAt: new Date("2026-11-14T00:05:00.000Z"),
      trigger: "routine",
    });
    await settleStaleCardsForRun(prisma, {
      threadId: thread,
      createdAt: mark,
      trigger: "routine",
    });
    expect(store[0]?.status).toBe("ready_for_review");
  });

  it("settles a user run against its createdAt snapshot", async () => {
    const { prisma, store } = fakePrisma([openCard("open", { staleAt: mark })]);
    await settleStaleCardsForRun(prisma, {
      threadId: thread,
      createdAt: mark,
      trigger: "user",
    });
    expect(store[0]?.status).toBe("superseded");
  });
});
