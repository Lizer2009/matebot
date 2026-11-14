import { describe, expect, it, vi } from "vitest";

/**
 * `cancel_interaction`: the tool the model calls when the user says "forget it".
 *
 * The important property is that the recorded state decides. A draft is cancelled;
 * a record that already ran is refused with words that say so, and the tool has no
 * path to an effect, so it can never be used to retract a send.
 */

vi.stubEnv("FEATURE_A2UI", "1");

const cancelService = vi.fn(async () => ({ status: "cancelled" as const, draftVersion: 3 }));
vi.mock("./interaction-field-writer.js", async () => {
  const actual = await vi.importActual<typeof import("./interaction-field-writer.js")>(
    "./interaction-field-writer.js",
  );
  return { ...actual, cancelInteractionService: cancelService };
});

const { cancelInteraction } = await import("./run-tools-interaction-cancel.js");

function context(status = "ready_for_review", surfaces = 1) {
  const row = {
    id: "ix-1",
    spaceId: "space-1",
    threadId: "thread-1",
    intent: "email.compose",
    status,
    draftVersion: 2,
    confirmedVersion: null,
    slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    plan: {
      intent: "email.compose",
      title: "Email",
      fields: [],
      nextStep: "render",
      riskLevel: "medium",
    },
  };
  const inFlight = status === "executing";
  const prisma = {
    interaction: {
      findUnique: async () => ({ ...row, approvalEffectId: inFlight ? "effect-1" : null }),
      findFirst: async () => row,
      findMany: async () =>
        surfaces === 0
          ? []
          : [
              {
                ...row,
                surfaces: [{ surfaceId: "surf-1" }],
              },
            ],
    },
    externalEffect: {
      findUnique: async () => (inFlight ? { id: "effect-1", status: "executing" } : null),
    },
  };
  return {
    deps: { prisma, events: {}, jobs: {} },
    run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId: "u1" },
    context: { userId: "u1", signal: new AbortController().signal },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    state: { effects: { consumedIds: [] } },
  } as never;
}

describe("cancel_interaction", () => {
  it("cancels a draft that has not run", async () => {
    cancelService.mockClear();
    const result = await cancelInteraction(context(), { interactionId: "ix-1", revision: 2 });
    expect(result).toMatchObject({ ok: true, interactionId: "ix-1", draftVersion: 3 });
    expect(cancelService).toHaveBeenCalledTimes(1);
    if (result.ok) expect(result.reply).not.toContain("撤销");
  });

  it("refuses a record that executed, and never calls the cancel writer", async () => {
    cancelService.mockClear();
    const result = await cancelInteraction(context("succeeded"), {
      interactionId: "ix-1",
      revision: 2,
    });
    expect(result).toMatchObject({ ok: false, error: "already_executed" });
    expect(cancelService).not.toHaveBeenCalled();
    if (!result.ok) expect(result.reply).toContain("无法撤销");
  });

  it("refuses while the action is in flight", async () => {
    cancelService.mockClear();
    const result = await cancelInteraction(context("executing"), {
      interactionId: "ix-1",
      revision: 2,
    });
    expect(result).toMatchObject({ ok: false, error: "in_flight" });
    expect(cancelService).not.toHaveBeenCalled();
  });

  it("refuses an in-flight send that still occupies the open kernel status", async () => {
    cancelService.mockClear();
    const ctx = context("ready_for_review");
    const prisma = (
      ctx as {
        deps: {
          prisma: {
            interaction: { findUnique: () => Promise<unknown> };
            externalEffect: { findUnique: () => Promise<unknown> };
          };
        };
      }
    ).deps.prisma;
    prisma.interaction.findUnique = async () => ({
      id: "ix-1",
      status: "ready_for_review",
      approvalEffectId: "effect-1",
    });
    prisma.externalEffect.findUnique = async () => ({ id: "effect-1", status: "ambiguous" });
    const result = await cancelInteraction(ctx, { interactionId: "ix-1", revision: 2 });
    expect(result).toMatchObject({ ok: false, error: "in_flight" });
    expect(cancelService).not.toHaveBeenCalled();
  });

  it("refuses to guess which card when several are open", async () => {
    const ctx = context();
    const prisma = (ctx as { deps: { prisma: { interaction: { findMany: unknown } } } }).deps
      .prisma;
    prisma.interaction.findMany = async () => [
      {
        id: "ix-1",
        title: "Email",
        status: "ready_for_review",
        confirmedVersion: null,
        intent: "email.compose",
        surfaces: [{ surfaceId: "s1" }],
      },
      {
        id: "ix-2",
        title: "Email 2",
        status: "ready_for_review",
        confirmedVersion: null,
        intent: "email.compose",
        surfaces: [{ surfaceId: "s2" }],
      },
    ];
    const result = await cancelInteraction(ctx, { revision: 2 });
    expect(result).toMatchObject({ ok: false, error: "ambiguous_target" });
  });

  it("requires the revision the card shows", async () => {
    const result = await cancelInteraction(context(), { interactionId: "ix-1" });
    expect(result).toMatchObject({ ok: false });
    expect(cancelService).not.toHaveBeenCalled();
  });
});
