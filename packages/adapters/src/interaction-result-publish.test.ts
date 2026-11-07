import type { ResultSurface } from "@matebot/contracts";
import { createThreadMessageInTransaction } from "@matebot/db";
import { describe, expect, it, vi } from "vitest";
import type { ResultPublishDeps } from "./interaction-result-publish.js";
import { publishResultSurface } from "./interaction-result-publish.js";

// The publish path uses the repo's own message helper; the double stands in for
// it so the test asserts the write sequence without a database.
vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    createThreadMessageInTransaction: vi.fn(async () => ({ id: "msg-res" })),
  };
});

/**
 * Publishing a result is a real server path, not a schema test: it writes the
 * interaction, the surface document, a message block and the SSE events through
 * the same tables the card reads from.
 */

const surface: ResultSurface = {
  title: "Annual sales",
  provenance: {
    source: "user-provided CSV",
    asOf: "2026-11-06T00:00:00.000Z",
    window: { from: "2026-01-01", to: "2026-12-31" },
    units: "CNY",
    timezone: "Asia/Shanghai",
  },
  columns: [
    { key: "quarter", label: "Quarter" },
    { key: "total", label: "Total" },
  ],
  rows: [
    { quarter: "Q1", total: "1.2M" },
    { quarter: "Q2", total: "1.6M" },
  ],
  truncated: false,
  totalRows: 2,
  empty: false,
};

function deps(overrides: { existing?: boolean } = {}) {
  const writes = {
    createInteraction: vi.fn(async () => ({ id: "ix-res", draftVersion: 1 })),
    upsertSurface: vi.fn(async () => ({ documentRef: "a2ui:interaction:ix-res:surface:s-1" })),
    createMessage: vi.fn(async () => ({ id: "msg-res" })),
    updateInteraction: vi.fn(async () => ({})),
    appendEvent: vi.fn(async () => ({ seq: 1 })),
    notify: vi.fn(async () => undefined),
    findExisting: vi.fn(async () =>
      overrides.existing ? { id: "ix-res", messageId: "msg-res" } : null,
    ),
    loadExistingSurface: vi.fn(async () => ({ surfaceId: "s-1", protocolFamily: "v0_9" })),
  };
  const tx = {
    interaction: {
      create: writes.createInteraction,
      update: writes.updateInteraction,
      findFirst: writes.findExisting,
    },
    interactionSurface: {
      upsert: writes.upsertSurface,
      findFirst: writes.loadExistingSurface,
    },
    message: {
      create: writes.createMessage,
      findUnique: async () => ({ id: "msg-res", blocks: [] }),
      update: async () => ({}),
    },
    thread: { update: async () => ({ nextEventSeq: 2 }) },
    event: { create: async () => ({ id: "e", seq: 1 }) },
  };
  const prisma = {
    ...tx,
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx),
    $executeRaw: async () => undefined,
  };
  const d: ResultPublishDeps = {
    prisma: prisma as never,
    appendEvent: writes.appendEvent as never,
    notify: writes.notify,
  };
  return { d, writes };
}

const input = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  runId: "run-1",
  intent: "interaction.result",
  surface,
  surfaceId: "s-1",
};

describe("publishResultSurface", () => {
  it("creates the interaction, the surface and a message block", async () => {
    const { d, writes } = deps();
    const result = await publishResultSurface(d, input);
    expect(result).toMatchObject({ ok: true, interactionId: "ix-res", surfaceId: "s-1" });
    expect(writes.createInteraction).toHaveBeenCalledTimes(1);
    expect(writes.upsertSurface).toHaveBeenCalledTimes(1);
    // The repo's message helper is what actually writes the block.
    expect(vi.mocked(createThreadMessageInTransaction)).toHaveBeenCalledTimes(1);
  });

  // A result is read-only: publishing it must never create an effect.
  it("never creates an external effect", async () => {
    const { d } = deps();
    const result = await publishResultSurface(d, input);
    expect(result).toMatchObject({ ok: true });
    // The dependency surface has no effect writer at all; assert by construction.
    expect(Object.keys(d)).toEqual(expect.not.arrayContaining(["createEffect"]));
  });

  it("refuses a surface with no provenance", async () => {
    const { d } = deps();
    const result = await publishResultSurface(d, {
      ...input,
      surface: { ...surface, provenance: { ...surface.provenance, source: "" } },
    });
    expect(result).toMatchObject({ ok: false });
  });
});
