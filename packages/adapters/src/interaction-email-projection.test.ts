import type { InteractionPlan } from "@matebot/contracts";
import { describe, expect, it, vi } from "vitest";
import { projectInteractionEmailSurface } from "./interaction-email-outcome.js";

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    appendEventInTransaction: vi.fn(async () => ({ id: "event-1", seq: 1 })),
  };
});

/**
 * The card's read-only sender row, across the stamps that rewrite the card in place.
 *
 * A confirm, an execute and a progress update each rebuild the `a2ui_surface` block from their
 * own fields. Rebuilding is how the card changes state; it is not a reason for the connection's
 * label to disappear. The label never changes mid-lifecycle, so the block being replaced is
 * always the right source for it.
 */

const PLAN: InteractionPlan = {
  intent: "email.compose",
  title: "冬天的问候",
  fields: [
    { name: "to", value: "alex@example.test", required: true, status: "resolved" },
    { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
    { name: "body", value: "正文", required: true, status: "resolved" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

function harness(existingBlocks: Array<Record<string, unknown>>) {
  const updates: Array<{ data: { blocks: Array<Record<string, unknown>> } }> = [];
  const tx = {
    interactionSurface: {
      findFirst: async () => ({ surfaceId: "surf-1", protocolFamily: "v0_9", document: [] }),
      upsert: async () => ({}),
    },
    message: {
      findUnique: async () => ({ id: "msg-1", blocks: existingBlocks }),
      update: async (args: { data: { blocks: Array<Record<string, unknown>> } }) => {
        updates.push(args);
        return {};
      },
    },
    thread: { update: async () => ({ nextEventSeq: 2 }) },
    run: {
      findUnique: async () => ({
        id: "run-1",
        status: "running",
        leaseOwner: null,
        firstResponseAt: null,
      }),
    },
    event: { create: async () => ({ id: "event-1", seq: 1 }) },
  } as never;
  return { tx, updates };
}

const cardWithLabel = [
  {
    kind: "a2ui_surface",
    interactionId: "ix-1",
    surfaceId: "surf-1",
    draftVersion: 1,
    intent: "email.compose",
    capability: "ready",
    senderLabel: "Gmail",
  },
];

describe("a stamped card keeps its sender label", () => {
  it.each([
    ["confirmation", { interactionStatus: "awaiting_approval" as const, confirmedVersion: 2 }],
    ["execution", { interactionStatus: "executing" as const }],
    ["success", { interactionStatus: "succeeded" as const }],
    ["failure", { interactionStatus: "failed" as const, error: "provider said no" }],
  ])("keeps the label on %s", async (_label, overrides) => {
    const { tx, updates } = harness(cardWithLabel);
    await projectInteractionEmailSurface(tx, {
      interaction: { id: "ix-1", messageId: "msg-1", title: "冬天的问候", summary: null },
      plan: PLAN,
      draftVersion: 2,
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      capability: "ready",
      ...overrides,
    });
    const block = updates.at(-1)?.data.blocks[0];
    expect(block?.senderLabel).toBe("Gmail");
  });

  it("does not invent a label when the card never had one", async () => {
    const { tx, updates } = harness([
      {
        kind: "a2ui_surface",
        interactionId: "ix-1",
        surfaceId: "surf-1",
        draftVersion: 1,
        intent: "email.compose",
        capability: "ready",
      },
    ]);
    await projectInteractionEmailSurface(tx, {
      interaction: { id: "ix-1", messageId: "msg-1", title: "冬天的问候", summary: null },
      plan: PLAN,
      draftVersion: 2,
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionStatus: "awaiting_approval",
      capability: "ready",
    });
    const block = updates.at(-1)?.data.blocks[0];
    expect(block).not.toHaveProperty("senderLabel");
  });

  it("takes the label from this card, not from a sibling surface on the same message", async () => {
    // A message can carry more than one surface. Copying whichever label came first would put
    // another card's connection on this one.
    const { tx, updates } = harness([
      {
        kind: "a2ui_surface",
        interactionId: "other",
        surfaceId: "surf-other",
        draftVersion: 1,
        intent: "email.compose",
        senderLabel: "别的邮箱",
      },
      ...cardWithLabel,
    ]);
    await projectInteractionEmailSurface(tx, {
      interaction: { id: "ix-1", messageId: "msg-1", title: "冬天的问候", summary: null },
      plan: PLAN,
      draftVersion: 2,
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionStatus: "awaiting_approval",
      capability: "ready",
    });
    const blocks = updates.at(-1)?.data.blocks ?? [];
    expect(blocks[0]?.senderLabel).toBe("别的邮箱");
    expect(blocks[1]?.senderLabel).toBe("Gmail");
  });
});
