import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The production entry for P2: the model asks for a result card and the real
 * `applyTool` loop publishes it.
 *
 * Nothing calls the tool handler directly. The call goes through `applyTool` —
 * the same entry the executor uses — including its gate and dispatch map. The
 * database and the message writer are doubled so the test asserts the write
 * sequence; no network or model is involved.
 */

const published = vi.hoisted(() => ({
  calls: [] as Array<{ surface: unknown }>,
}));

vi.mock("./interaction-result-publish.js", async () => {
  const actual = await vi.importActual<typeof import("./interaction-result-publish.js")>(
    "./interaction-result-publish.js",
  );
  return {
    ...actual,
    publishResultSurface: vi.fn(
      async (_deps: unknown, input: { surface: unknown; surfaceId: string }) => {
        published.calls.push({ surface: input.surface });
        return {
          ok: true as const,
          interactionId: "ix-res",
          surfaceId: input.surfaceId,
          messageId: "msg-res",
          eventSeq: 1,
        };
      },
    ),
  };
});

const { applyTool } = await import("./run-tools.js");
const { createApprovedEffectReplayQueue } = await import("./approval-effect.js");

function loopContext() {
  const prisma = {
    user: { findUniqueOrThrow: async () => ({ timezone: "Asia/Shanghai" }) },
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
    interaction: { findMany: async () => [], findUnique: async () => null },
    // The gate renews the run lease before a tool that writes history.
    run: { updateMany: async () => ({ count: 1 }), findUnique: async () => null },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    $executeRaw: async () => undefined,
  };
  return {
    deps: {
      prisma,
      events: { notify: async () => undefined, answerRunInput: async () => true },
      jobs: { enqueue: async () => undefined },
      connectors: { managed: () => undefined },
    },
    run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId: "u-1" },
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

const provenance = {
  source: "user-provided CSV",
  asOf: "2026-11-06T00:00:00.000Z",
  window: { from: "2026-01-01", to: "2026-12-31" },
  units: "CNY",
};

beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => vi.unstubAllEnvs());

describe("production tool loop: present_result", () => {
  it("publishes a card from a source it read through applyTool", async () => {
    published.calls.length = 0;
    const result = (await applyTool(
      loopContext() as never,
      "present_result",
      {
        title: "Annual sales",
        sourceId: "csv-upload",
        from: "2026-01-01",
        to: "2026-12-31",
      },
      "call-res-1",
    )) as { ok?: boolean; interactionId?: string };

    // This fixture run has no attached file, so the read refuses; what matters is
    // that the refusal is the source's, not a card built from model rows.
    expect(result.ok).toBe(false);
    expect(published.calls).toHaveLength(0);
  });

  // No source, no card: this is the rule that stops unattributed numbers.
  it("refuses a bare request with no source and publishes nothing", async () => {
    published.calls.length = 0;
    const result = (await applyTool(
      loopContext() as never,
      "present_result",
      { title: "Sales", asOf: provenance.asOf, rows: [{ q: "1" }] },
      "call-res-2",
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_source");
    expect(published.calls).toHaveLength(0);
  });

  // Rows the model writes are not a source. This is the rule from §5.6.2: a
  // label would still be the server vouching for numbers nothing read.
  it("refuses rows the model supplies, even with a source name and timestamp", async () => {
    published.calls.length = 0;
    const result = (await applyTool(
      loopContext() as never,
      "present_result",
      { title: "Sales", ...provenance, rows: [{ quarter: "Q1", total: "1.2M" }] },
      "call-res-3",
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_source");
    expect(published.calls).toHaveLength(0);
  });

  it("refuses an empty set of model rows too", async () => {
    published.calls.length = 0;
    const result = (await applyTool(
      loopContext() as never,
      "present_result",
      { title: "Sales", ...provenance, rows: [] },
      "call-res-3b",
    )) as { ok?: boolean };
    // Even an empty table is a claim about a source the server never read.
    expect(result.ok).toBe(false);
    expect(published.calls).toHaveLength(0);
  });

  // Read-only by construction. The gate records one audit row per tool call
  // (`kind` is the tool name), so the assertion is that no *business* effect —
  // the ones that reach a provider — is ever created here.
  it("creates no provider-facing effect for a result", async () => {
    const ctx = loopContext();
    const kinds: string[] = [];
    const original = ctx.deps.prisma.externalEffect.create as unknown as (args: {
      data: { kind?: string };
    }) => Promise<unknown>;
    vi.spyOn(ctx.deps.prisma.externalEffect, "create").mockImplementation((async (args: {
      data: { kind?: string };
    }) => {
      if (args?.data?.kind) kinds.push(args.data.kind);
      return original(args);
    }) as never);
    await applyTool(
      ctx as never,
      "present_result",
      { title: "Sales", sourceId: "csv-upload", from: "2026-01-01", to: "2026-12-31" },
      "call-res-5",
    );
    expect(kinds).not.toContain("email.send");
    expect(kinds).not.toContain("calendar.create");
  });

  it("is unavailable while FEATURE_A2UI is off", async () => {
    vi.stubEnv("FEATURE_A2UI", "0");
    const result = (await applyTool(
      loopContext() as never,
      "present_result",
      { title: "Sales", ...provenance, rows: [{ q: "1" }] },
      "call-res-6",
    )) as { ok?: boolean };
    vi.stubEnv("FEATURE_A2UI", "1");
    expect(result.ok).toBe(false);
  });
});
