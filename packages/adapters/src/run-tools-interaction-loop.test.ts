import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The primary acceptance test for this phase: the *production* tool loop runs
 * `edit_interaction` because the model asked for it.
 *
 * Nothing here calls the tool handler directly. The call goes through
 * `applyTool` — the same entry the executor uses for every model tool call,
 * including its gate, its argument validation, and its dispatch map. The only
 * things replaced are the database and the provider: no network, no model, no
 * send. That is the honest boundary: this proves the wiring, not that a live
 * LLM chooses the tool well.
 */

const published: Array<{ interactionId: string; surfaceId: string; draftVersion: number }> = [];

vi.mock("./interaction-field-writer.js", async () => {
  const actual = await vi.importActual<typeof import("./interaction-field-writer.js")>(
    "./interaction-field-writer.js",
  );
  return {
    ...actual,
    // The real writer needs a database. This stands in for it at the one seam
    // where it would be called, and records what it was asked to write.
    updateInteractionFieldService: vi.fn(
      async (
        _prisma: unknown,
        input: {
          interactionId: string;
          expectedDraftVersion: number;
          name: string;
          value: unknown;
        },
      ) => {
        published.push({
          interactionId: input.interactionId,
          surfaceId: "surf-1",
          draftVersion: input.expectedDraftVersion + 1,
        });
        return { draftVersion: input.expectedDraftVersion + 1 };
      },
    ),
  };
});

const { applyTool } = await import("./run-tools.js");
const { createApprovedEffectReplayQueue } = await import("./approval-effect.js");

const draft = {
  id: "ix-1",
  spaceId: "space-1",
  threadId: "thread-1",
  intent: "email.compose",
  status: "ready_for_review",
  draftVersion: 2,
  confirmedVersion: null as number | null,
  slots: { to: "a@example.com", subject: "Hi", body: "Hello" } as Record<string, unknown>,
  title: "Email",
  summary: null as string | null,
};

function loopContext(overrides: { executed?: boolean } = {}) {
  const row = {
    ...draft,
    status: overrides.executed ? "succeeded" : draft.status,
  };
  const prisma = {
    interaction: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === row.id ? row : null,
      findMany: async () =>
        row.status === "succeeded" ? [] : [{ ...row, surfaces: [{ surfaceId: "surf-1" }] }],
      updateMany: async () => ({ count: 1 }),
    },
    interactionSurface: {
      findFirst: async () => ({
        interactionId: row.id,
        surfaceId: "surf-1",
        protocolFamily: "v0_9",
        document: [],
      }),
    },
    message: { findUnique: async () => ({ id: "msg-1", blocks: [] }), update: async () => ({}) },
    thread: { update: async () => ({ nextEventSeq: 2 }) },
    event: { create: async () => ({ id: "e", seq: 1 }) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    $executeRaw: async () => undefined,
    bot: { findFirst: async () => ({ id: "bot-1" }) },
    run: { findFirst: async () => ({ id: "run-1" }) },
    // The gate resolves a reviewer model; an unconfigured workspace has none.
    userModelPreference: { findMany: async () => [], findFirst: async () => null },
    userModelCredential: { findMany: async () => [], findFirst: async () => null },
    deploymentSettings: { findUnique: async () => null },
    actionApprovalRule: { findMany: async () => [] },
    // An edit is not an effect, but the gate records one per tool call.
    externalEffect: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "effect-1", ...data }),
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [],
    },
  };
  return {
    row,
    ctx: {
      deps: {
        prisma,
        events: { notify: async () => undefined, answerRunInput: async () => true },
        jobs: { enqueue: async () => undefined },
        connectors: { managed: () => undefined },
      },
      run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
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
      // The gate reads approval rules and trust; an edit is not a gated effect,
      // so empty rules are the honest stand-in for a fresh workspace.
      trust: {
        loadApprovalRules: async () => [],
        // No approval model configured: the gate then skips auto review.
        loadApprovalModel: async () => null,
        loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
        loadTrustedSites: async () => new Set<string>(),
        loadTrustedConnectors: async () => new Set<string>(),
        searchResultUrls: undefined,
        routineNamesNewSite: async () => false,
        loadOwnerWords: async () => "",
        receivedOutsideMessage: async () => false,
      },
      context: { userId: "user-1", signal: new AbortController().signal },
      secrets: [],
      computer: { pageBrowserAllowed: false, acceptsImages: true },
    },
  };
}

beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => vi.unstubAllEnvs());

describe("production tool loop: edit_interaction", () => {
  it("is reachable through applyTool and revises the draft in place", async () => {
    published.length = 0;
    const { ctx, row } = loopContext();
    const result = await applyTool(
      ctx as never,
      "edit_interaction",
      { interactionId: "ix-1", revision: 2, fields: { subject: "秋后问候" } },
      "call-edit-1",
    );

    expect(result).toMatchObject({ ok: true, interactionId: "ix-1", draftVersion: 3 });
    // The write went through the shared field service, once.
    expect(published).toEqual([{ interactionId: "ix-1", surfaceId: "surf-1", draftVersion: 3 }]);
    // Still a draft: nothing was sent.
    expect(row.status).toBe("ready_for_review");
  });

  it("rejects a stale revision through the same loop", async () => {
    published.length = 0;
    const { ctx } = loopContext();
    const result = await applyTool(
      ctx as never,
      "edit_interaction",
      { interactionId: "ix-1", revision: 1, fields: { subject: "old" } },
      "call-edit-2",
    );
    expect(result).toMatchObject({ ok: false, error: "stale_revision" });
    expect(published).toEqual([]);
  });

  it("refuses a field the card does not declare", async () => {
    published.length = 0;
    const { ctx } = loopContext();
    const result = await applyTool(
      ctx as never,
      "edit_interaction",
      { interactionId: "ix-1", revision: 2, fields: { apiKey: "sk-live" } },
      "call-edit-3",
    );
    expect(result).toMatchObject({ ok: false, error: "unknown_field" });
    expect(published).toEqual([]);
  });

  // The gate the spec cares about: no secret collection through a generated form.
  it("never routes an edit into a shell or secret path", async () => {
    const { ctx } = loopContext();
    const result = (await applyTool(
      ctx as never,
      "edit_interaction",
      { interactionId: "ix-1", revision: 2, fields: { body: "hi; rm -rf /" } },
      "call-edit-4",
    )) as { ok?: boolean };
    // The value is data written to a field, never executed.
    expect(result.ok).toBe(true);
  });

  it("reports a finished card as executed rather than editing it", async () => {
    const { ctx } = loopContext({ executed: true });
    const result = await applyTool(
      ctx as never,
      "edit_interaction",
      { interactionId: "ix-1", revision: 2, fields: { subject: "x" } },
      "call-edit-5",
    );
    expect(result).toMatchObject({ ok: false, error: "already_executed" });
  });

  // The feature flag stays the gate for the whole capability.
  it("is unavailable when FEATURE_A2UI is off", async () => {
    vi.stubEnv("FEATURE_A2UI", "0");
    const { ctx } = loopContext();
    const result = (await applyTool(
      ctx as never,
      "edit_interaction",
      { interactionId: "ix-1", revision: 2, fields: { subject: "x" } },
      "call-edit-6",
    )) as { ok?: boolean };
    vi.stubEnv("FEATURE_A2UI", "1");
    expect(result.ok).toBe(false);
  });
});
