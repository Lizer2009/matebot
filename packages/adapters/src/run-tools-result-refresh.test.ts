import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `refresh_result` through the production loop, against a real registered source.
 *
 * The point is that the second turn actually re-reads: the window in the new
 * provenance is the new one, and the rows come from the source's read, not from
 * relabelled copies of the first answer.
 */

const readCalls = vi.hoisted(() => [] as Array<{ from: string; to: string }>);
const republished = vi.hoisted(() => [] as Array<{ provenance: Record<string, unknown> }>);

// Record reads without replacing the validator: the real `queryResultSource`
// still refuses unregistered sources and bad windows, so the test proves both.
// A test-only source is registered through the same seam a deployment uses.

const core = await import("@matebot/core");
const { refreshResult } = await import("./run-tools-result-refresh.js");

core.registerResultSource({
  id: "csv-upload-test",
  label: "Uploaded spreadsheet",
  requiresConnection: null,
  read: async (input: { window: { from: string; to: string } }) => {
    readCalls.push({ from: input.window.from, to: input.window.to });
    // The source returns rows derived from the window, so a relabel would show.
    return {
      ok: true as const,
      rows: [{ quarter: input.window.from, total: "1" }],
      asOf: "2026-11-06T00:00:00.000Z",
      units: "CNY",
    };
  },
});
const { applyTool } = await import("./run-tools.js");
const { createApprovedEffectReplayQueue } = await import("./approval-effect.js");

const resultRow = {
  id: "ix-res",
  spaceId: "space-1",
  threadId: "thread-1",
  intent: "interaction.result",
  draftVersion: 3,
  title: "Annual sales",
  slots: {},
};

function deps() {
  return {
    // The person named the period they want the card re-read for.
    userPrompt: "sales for last quarter",
    loadInteraction: async () => resultRow,
    listOpenResults: async () => [{ taskId: "ix-res", label: "Annual sales" }],
    connectionFor: async () => null,
    republish: async (input: { surface: { provenance: Record<string, unknown> } }) => {
      republished.push({ provenance: input.surface.provenance });
      return { ok: true as const, draftVersion: 4 };
    },
  };
}

const ctx = {
  deps: {},
  run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId: "u-1" },
} as never;

beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => vi.unstubAllEnvs());

describe("refresh_result", () => {
  it("re-reads csv-upload through the file reader instead of the unwired registry stub", async () => {
    const csvRead = vi.fn(async (input: { window: { from: string; to: string } }) => ({
      ok: true as const,
      rows: [],
      asOf: "2026-11-14T00:00:00.000Z",
      sourceLabel: "Upload: sample-quarters.csv",
      window: input.window,
    }));
    const result = await refreshResult(
      ctx,
      { sourceId: "csv-upload", from: "2020-01-01", to: "2020-03-31", interactionId: "ix-res" },
      { ...deps(), csvRead },
    );
    expect(result).toMatchObject({ ok: true, interactionId: "ix-res" });
    expect(csvRead).toHaveBeenCalled();
    expect(republished.at(-1)?.provenance.source).toMatch(/sample-quarters/);
  });

  it("re-reads the source for the new window and reports its provenance", async () => {
    readCalls.length = 0;
    republished.length = 0;
    const result = await refreshResult(
      ctx,
      { sourceId: "csv-upload-test", from: "2026-07-01", to: "2026-09-30" },
      deps(),
    );
    expect(result).toMatchObject({ ok: true, interactionId: "ix-res" });
    // The source was asked for the *new* window.
    expect(readCalls).toEqual([{ from: "2026-07-01", to: "2026-09-30" }]);
    // The card's provenance says the new window, not the old one relabelled.
    expect(republished[0]?.provenance.window).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(republished[0]?.provenance.units).toBe("CNY");
  });

  it("refuses an unregistered source without reading anything", async () => {
    readCalls.length = 0;
    const result = await refreshResult(
      ctx,
      { sourceId: "https://evil.example/sql", from: "2026-01-01", to: "2026-12-31" },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, error: "unknown_source" });
    expect(readCalls).toEqual([]);
  });

  it("refuses a stale revision without reading", async () => {
    readCalls.length = 0;
    const result = await refreshResult(
      ctx,
      { sourceId: "csv-upload-test", from: "2026-01-01", to: "2026-12-31", revision: 1 },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, error: "stale_revision" });
    expect(readCalls).toEqual([]);
  });

  it("asks which card when several results are open", async () => {
    const two = {
      ...deps(),
      listOpenResults: async () => [
        { taskId: "ix-a", label: "Sales" },
        { taskId: "ix-b", label: "Traffic" },
      ],
    };
    const result = await refreshResult(
      ctx,
      { sourceId: "csv-upload-test", from: "2026-01-01", to: "2026-12-31" },
      two,
    );
    expect(result).toMatchObject({ ok: false, error: "ambiguous_target" });
    if (result.ok) return;
    expect(result.candidates).toHaveLength(2);
  });

  /**
   * A refresh re-reads a different window on a card the person is looking at. A
   * period nobody asked for must not replace the one they were shown.
   */
  it("asks for the period instead of substituting one nobody stated", async () => {
    readCalls.length = 0;
    const result = await refreshResult(
      ctx,
      { sourceId: "csv-upload-test", from: "2026-01-01", to: "2026-03-31" },
      { ...deps(), userPrompt: "update the numbers on that card" },
    );
    expect(result).toMatchObject({ ok: false, error: "unstated_window" });
    expect(readCalls).toEqual([]);
  });

  it("re-reads a period the model admits choosing, and says so on the card", async () => {
    readCalls.length = 0;
    republished.length = 0;
    const result = await refreshResult(
      ctx,
      {
        sourceId: "csv-upload-test",
        from: "2026-01-01",
        to: "2026-03-31",
        defaultedWindow: true,
      },
      { ...deps(), userPrompt: "update the numbers on that card" },
    );
    expect(result).toMatchObject({ ok: true });
    expect(republished[0]?.provenance.defaultedWindow).toBe(true);
  });

  it("refuses a window whose end precedes its start", async () => {
    const result = await refreshResult(
      ctx,
      { sourceId: "csv-upload-test", from: "2026-12-31", to: "2026-01-01" },
      deps(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("refresh_result through applyTool", () => {
  function loopContext() {
    const prisma = {
      userModelPreference: { findMany: async () => [], findFirst: async () => null },
      userModelCredential: { findMany: async () => [], findFirst: async () => null },
      deploymentSettings: { findUnique: async () => null },
      actionApprovalRule: { findMany: async () => [] },
      externalEffect: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "e", ...data }),
        updateMany: async () => ({ count: 1 }),
        findMany: async () => [],
      },
      interaction: {
        findUnique: async () => ({ ...resultRow, messageId: "msg-1" }),
        // The in-place republish looks the interaction up by id before writing.
        findFirst: async () => ({ id: resultRow.id, messageId: "msg-1", draftVersion: 3 }),
        findMany: async () => [resultRow],
        updateMany: async () => ({ count: 1 }),
      },
      interactionSurface: {
        findFirst: async () => ({ surfaceId: "s-1", protocolFamily: "v0_9" }),
        upsert: async () => ({ surfaceId: "s-1", draftVersion: 4 }),
      },
      message: { findUnique: async () => ({ id: "msg-1", blocks: [] }), update: async () => ({}) },
      user: { findUniqueOrThrow: async () => ({ timezone: "Asia/Shanghai" }) },
      run: {
        updateMany: async () => ({ count: 1 }),
        // A live run, so writing the surface event is allowed.
        findUnique: async () => ({
          status: "running",
          startedAt: new Date(),
          firstResponseAt: null,
          userId: "u-1",
          leaseOwner: "w-1",
          leaseFence: 1,
        }),
      },
      // appendEventInTransaction bumps the thread's event sequence.
      thread: {
        update: async () => ({ nextEventSeq: 2 }),
        findUnique: async () => ({ id: "thread-1", nextEventSeq: 1 }),
        findFirst: async () => ({ id: "thread-1" }),
      },
      event: { create: async () => ({ id: "e", seq: 1 }) },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
      $executeRaw: async () => undefined,
      $queryRaw: async () => [],
    };
    return {
      deps: {
        prisma,
        events: { notify: async () => undefined, answerRunInput: async () => true },
        jobs: { enqueue: async () => undefined },
        connectors: { managed: () => undefined },
      },
      run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId: "u-1" },
      // The person named the period, so the server accepts the window as theirs.
      task: { prompt: "show the sales for last quarter on that card" },
      bot: { id: "bot-1" },
      thread: { id: "thread-1", groupId: null },
      runId: "run-1",
      workerId: "w-1",
      fence: 1,
      attempt: { id: "a-1" },
      source: { ownerStartedRun: true, messagingChannelRun: false },
      state: {
        tainted: false,
        handedOff: false,
        ownerSettingsRefused: false,
        approval: { pausePending: false, request: undefined },
        effects: {
          counts: new Map<string, number>(),
          occurrences: [] as { executionId: string; fingerprint: string; occurrence: number }[],
          restoredPending: undefined,
          consumedIds: new Set<string>(),
          pendingTurnCheckpoints: new Map(),
          storedTurnCheckpoint: undefined,
        },
        toolResults: new Map(),
      },
      tools: {
        disabled: new Set<string>(),
        builtins: [],
        connectedPlugins: [],
        approvedReplays: createApprovedEffectReplayQueue([]),
        connector: new Map(),
      },
      trust: {
        loadApprovalRules: async () => [],
        loadApprovalModel: async () => null,
        loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
        loadTrustedSites: async () => new Set<string>(),
        loadTrustedConnectors: async () => new Set<string>(),
        searchResultUrls: undefined,
        routineNamesNewSite: async () => false,
        loadOwnerWords: async () => "",
        receivedOutsideMessage: async () => false,
      },
      context: { userId: "u-1", signal: new AbortController().signal },
      secrets: [],
      computer: { pageBrowserAllowed: false, acceptsImages: true },
    };
  }

  it("is reachable through the production loop", async () => {
    readCalls.length = 0;
    const result = (await applyTool(
      loopContext() as never,
      "refresh_result",
      {
        interactionId: "ix-res",
        sourceId: "csv-upload-test",
        from: "2026-07-01",
        to: "2026-09-30",
      },
      "call-ref-1",
    )) as { ok?: boolean; error?: string };
    // Surface the real outcome so a wiring break is diagnosable.
    expect({ ok: result.ok, error: result.error }).toEqual({ ok: true, error: undefined });
    expect(readCalls).toHaveLength(1);
  });
});

describe("refresh_result's window rule is reachable, not a dead end", () => {
  it("offers the model a way to say it chose the dates", async () => {
    // Without this the refusal could never be answered: the model would have to
    // guess a period the person never gave, which is the defect it exists to stop.
    const { builtinAgentTools } = await import("./builtin-tools.js");
    const refresh = builtinAgentTools.find((tool) => tool.name === "refresh_result")!;
    const properties = refresh.inputSchema.properties as Record<string, unknown>;
    expect(properties.defaultedWindow).toMatchObject({ type: "boolean" });
    // And it is not required: an ordinary refresh states the period the person named.
    expect(refresh.inputSchema.required).not.toContain("defaultedWindow");
  });
});
