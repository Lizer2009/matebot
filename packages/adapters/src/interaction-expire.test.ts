import type { PrismaClient } from "@matebot/db";
import { describe, expect, it, vi } from "vitest";
import { expireDueInteractions, expireInteraction } from "./interaction-expire.js";

type Row = {
  id: string;
  status: string;
  expiresAt: Date | null;
  messageId: string | null;
  intent: string;
  slots: Record<string, unknown>;
  staleAt: Date | null;
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
          template: "action-approval-card",
        },
      ],
    });
  }
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return store.filter((row) => match(row, where));
  });
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    return store.find((row) => row.id === where.id) ?? null;
  });
  const updateMany = vi.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = store.filter((row) => match(row, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    },
  );
  return {
    store,
    messages,
    findMany,
    prisma: {
      interaction: { findMany, findUnique, updateMany },
      message: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          return messages.get(where.id) ?? null;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { blocks: unknown } }) => {
          const current = messages.get(where.id);
          if (!current) return null;
          current.blocks = data.blocks as Record<string, unknown>[];
          return current;
        }),
      },
      interactionEvent: { create: vi.fn().mockResolvedValue({ id: "ev-1" }) },
    } as unknown as PrismaClient,
  };
}

function match(row: Row, where: Record<string, unknown>): boolean {
  if (where.id && row.id !== where.id) return false;
  if (typeof where.status === "string" && row.status !== where.status) return false;
  if (where.status && typeof where.status === "object" && where.status !== null && "in" in where.status) {
    if (!(where.status as { in: string[] }).in.includes(row.status)) return false;
  }
  if (where.expiresAt && typeof where.expiresAt === "object" && where.expiresAt !== null && "lt" in where.expiresAt) {
    if (!row.expiresAt || !(row.expiresAt < (where.expiresAt as { lt: Date }).lt)) return false;
  }
  return true;
}

const past = new Date("2026-11-14T00:00:00.000Z");
const now = new Date("2026-11-14T00:31:00.000Z");

function approval(id: string, extra?: Partial<Row>): Row {
  return {
    id,
    status: "awaiting_approval",
    expiresAt: past,
    messageId: `m-${id}`,
    intent: "email.compose",
    slots: { to: "example@example.test", subject: "产品发布" },
    staleAt: null,
    ...extra,
  };
}

describe("expireDueInteractions", () => {
  it("expires an overdue approval card and restamps the block", async () => {
    const { prisma, store, messages, findMany } = fakePrisma([approval("due")]);
    const result = await expireDueInteractions(prisma, { now });
    expect(result.expired).toEqual(["due"]);
    expect(store[0]).toMatchObject({ status: "expired", staleAt: null });
    expect(messages.get("m-due")?.blocks[0]).toMatchObject({
      status: "expired",
      template: "action-expired-card",
    });
    expect(findMany.mock.calls[0]![0].where.status.in).toEqual([
      "collecting",
      "ready_for_review",
      "awaiting_approval",
    ]);
  });

  it("leaves a ready_for_review card without expiresAt alone", async () => {
    const { prisma, store } = fakePrisma([
      approval("draft", { status: "ready_for_review", expiresAt: null }),
    ]);
    expect(await expireDueInteractions(prisma, { now })).toEqual({ expired: [] });
    expect(store[0]?.status).toBe("ready_for_review");
  });

  it("does not expire unknown even when expiresAt was written", async () => {
    const { prisma, store } = fakePrisma([
      approval("maybe", { status: "unknown", expiresAt: past }),
    ]);
    expect(await expireDueInteractions(prisma, { now })).toEqual({ expired: [] });
    expect(store[0]?.status).toBe("unknown");
    expect(await expireInteraction(prisma, "maybe")).toEqual({ expired: false });
  });
});
