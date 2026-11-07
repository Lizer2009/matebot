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

function deps(storedSummary: string | null) {
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
      findUnique: async () => ({ id: "msg-1", blocks: [] }),
      update: async () => ({}),
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return {
    prisma: prisma as never,
    appendEvent: vi.fn(async () => ({ seq: 1 })),
    notify: vi.fn(async () => undefined),
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
});
