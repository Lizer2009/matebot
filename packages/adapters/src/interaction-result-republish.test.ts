import { describe, expect, it, vi } from "vitest";
import { republishResultSurface } from "./interaction-result-publish.js";

/**
 * A refresh may change the window; it may not quietly change the source.
 *
 * The card the user is looking at was drawn from one place. Republishing it with
 * a different source would put other numbers under a name the reader already
 * trusted, so the republish refuses rather than relabelling.
 */

const surface = {
  title: "Pipeline",
  provenance: { source: "user-provided CSV", asOf: "2026-11-06T00:00:00Z" },
  columns: [{ key: "stage", label: "Stage" }],
  rows: [{ stage: "Won" }],
  truncated: false,
  totalRows: 1,
  empty: false,
};

function deps(storedSummary: string | null, existingBlocks: unknown[] = []) {
  const updates: Array<{ data: { blocks: Array<Record<string, unknown>> } }> = [];
  const prisma = {
    interaction: {
      findFirst: async () => ({
        id: "ix-1",
        messageId: "msg-1",
        draftVersion: 3,
        summary: storedSummary,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    interactionSurface: {
      findFirst: async () => ({ surfaceId: "surf-1", protocolFamily: "v0_9" }),
      upsert: async () => ({ surface: {}, documentRef: "a2ui:interaction:ix-1:surface:surf-1" }),
    },
    message: {
      findUnique: async () => ({ id: "msg-1", blocks: existingBlocks }),
      update: async (args: { data: { blocks: Array<Record<string, unknown>> } }) => {
        updates.push(args);
        return {};
      },
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return {
    prisma: prisma as never,
    appendEvent: vi.fn(async () => ({ seq: 1 })),
    notify: vi.fn(async () => undefined),
    updates,
  };
}

describe("republishResultSurface", () => {
  it("refuses to relabel a card with a different source", async () => {
    const result = await republishResultSurface(deps("user-provided CSV"), {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      surface: { ...surface, provenance: { ...surface.provenance, source: "another system" } },
    });
    expect(result).toEqual({ ok: false, error: "source_changed" });
  });

  it("allows the same source with a new window", async () => {
    const result = await republishResultSurface(deps("user-provided CSV"), {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      surface: {
        ...surface,
        provenance: {
          ...surface.provenance,
          window: { from: "2026-07-01", to: "2026-09-30" },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("keeps the sender label when it refreshes a card in place", async () => {
    // A refresh changes the window, not the card. Rebuilding the block without the connection's
    // label would blank the read-only sender row on a card the person is already reading.
    const d = deps("user-provided CSV", [
      {
        kind: "a2ui_surface",
        interactionId: "ix-1",
        surfaceId: "surf-1",
        draftVersion: 3,
        senderLabel: "Gmail",
      },
    ]);
    const result = await republishResultSurface(d, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      surface: {
        ...surface,
        provenance: {
          ...surface.provenance,
          window: { from: "2026-07-01", to: "2026-09-30" },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(d.updates.at(-1)?.data.blocks[0]?.senderLabel).toBe("Gmail");
  });

  it("does not invent a label on a card that never had one", async () => {
    const d = deps("user-provided CSV", [
      { kind: "a2ui_surface", interactionId: "ix-1", surfaceId: "surf-1", draftVersion: 3 },
    ]);
    await republishResultSurface(d, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      surface,
    });
    expect(d.updates.at(-1)?.data.blocks[0]).not.toHaveProperty("senderLabel");
  });
});
