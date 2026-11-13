import { describe, expect, it, vi } from "vitest";

// The card kernel owns the "is this a new card or the one already on screen" decision, so
// `present_interaction` must hand it the plan and let it look. This suite isolates that one
// observable: `publishOrAmend` is called, and no local `interaction.findFirst` runs.
//
// (The brief named this file `run-tools-interaction-amend.test.ts`, but that path already holds
// the `edit_interaction` amendment suite, so this one lives beside it instead.)

const publish = vi.fn();
const publishDirect = vi.fn(() => {
  throw new Error("present_interaction must go through publishOrAmend");
});

vi.doMock("./interaction-publish.js", async () => {
  const actual = await vi.importActual<typeof import("./interaction-publish.js")>(
    "./interaction-publish.js",
  );
  return { ...actual, publishOrAmend: publish, publishInteractionSurface: publishDirect };
});

const plan = {
  intent: "email.compose",
  title: "产品发布",
  fields: [
    // `resolved` is the plan vocabulary's word for a field with a value; the brief's
    // `filled` is not in `InteractionFieldStatus`.
    { name: "to", value: "418452732@qq.com", required: true, status: "resolved" as const },
    { name: "subject", value: "产品发布", required: true, status: "resolved" as const },
    { name: "body", value: "内容", required: true, status: "resolved" as const },
  ],
  // `confirm` is not in the plan vocabulary either; `ask` is what a fully resolved draft
  // that still needs a person says.
  nextStep: "ask" as const,
  riskLevel: "low" as const,
};

describe("present_interaction", () => {
  // The regression this task closes: a second present must not create a second card.
  it("publishes or amends through one call, never through a local draft lookup", async () => {
    vi.stubEnv("FEATURE_A2UI", "1");
    publish.mockReset();
    publishDirect.mockClear();
    publish.mockResolvedValueOnce({
      interactionId: "i1",
      surfaceId: "s1",
      messageId: "m1",
      documentRef: "ref",
      draftVersion: 2,
      eventSeq: 1,
      amended: true,
      missingRequired: [],
      plan,
      slots: { to: "418452732@qq.com", subject: "产品发布", body: "内容" },
    });
    const { interactionTools: tools } = await import("./run-tools-interaction.js");

    const findFirst = vi.fn();
    const handler = tools.present_interaction!;
    const finish = vi.fn((value: unknown) => value);
    await handler(
      {
        deps: {
          // No `connection` rows: the preflight stamp is "not connected", which must still
          // reach the publish call untouched — a connection card is not an open card.
          prisma: { interaction: { findFirst }, connection: { findMany: async () => [] } },
          events: { notify: vi.fn() },
        },
        run: { id: "r1", spaceId: "sp1", threadId: "t1", botId: "b1" },
        context: { userId: "u1" },
      } as never,
      { args: { plan }, finish } as never,
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishDirect).not.toHaveBeenCalled();
    // The kernel resolves the card; a local findFirst would be a second source of truth.
    expect(findFirst).not.toHaveBeenCalled();
    // The capability stamp still flows through: the kernel does not decide it.
    expect(publish.mock.calls[0]![1]).toMatchObject({
      spaceId: "sp1",
      threadId: "t1",
      status: "needs_connection",
    });
    vi.unstubAllEnvs();
  });
});
