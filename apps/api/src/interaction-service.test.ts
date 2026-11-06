import type { InteractionPlan } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    appendEventInTransaction: vi.fn(async () => ({ id: "event-1", seq: 1 })),
  };
});

import {
  confirmInteractionService,
  executeConfirmedInteractionService,
  InteractionEffectRunMissingError,
  InteractionSendRejectedError,
} from "./interaction-service.js";

const plan: InteractionPlan = {
  intent: "email.compose",
  title: "Send email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved" },
    { name: "subject", value: "Hi", required: true, status: "resolved" },
    { name: "body", value: "Hello", required: true, status: "resolved" },
  ],
  nextStep: "request_approval",
  riskLevel: "medium",
};

type InteractionRecord = {
  id: string;
  spaceId: string;
  threadId: string;
  runId: string | null;
  intent: string;
  status: string;
  draftVersion: number;
  confirmedVersion: number | null;
  plan: InteractionPlan;
  slots: Record<string, unknown>;
  title: string | null;
  summary: string | null;
  approvalEffectId: string | null;
  messageId: string | null;
};

type EffectRecord = {
  id: string;
  spaceId: string;
  runId: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: Record<string, unknown>;
  reviewDecision: string | null;
  reviewReason: string | null;
};

function memoryPrisma(interaction: InteractionRecord) {
  const interactions = new Map<string, InteractionRecord>([[interaction.id, interaction]]);
  const effects = new Map<string, EffectRecord>();
  let effectSeq = 0;
  const tx = {
    interaction: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        interactions.get(where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; draftVersion: number };
        data: Partial<InteractionRecord>;
      }) => {
        const row = interactions.get(where.id);
        if (!row || row.draftVersion !== where.draftVersion) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    interactionSurface: {
      findFirst: async () => null,
    },
    message: {
      findUnique: async () => null,
      update: async () => {
        throw new Error("message update was not expected");
      },
    },
    externalEffect: {
      findUnique: async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
        if (where.idempotencyKey) return effects.get(where.idempotencyKey) ?? null;
        if (where.id) {
          return [...effects.values()].find((effect) => effect.id === where.id) ?? null;
        }
        return null;
      },
      create: async ({ data }: { data: Omit<EffectRecord, "id"> }) => {
        if (effects.has(data.idempotencyKey)) {
          const error = new Error("Unique constraint failed");
          (error as { code?: string }).code = "P2002";
          throw error;
        }
        effectSeq += 1;
        const effect: EffectRecord = { id: `effect-${effectSeq}`, ...data };
        effects.set(effect.idempotencyKey, effect);
        return effect;
      },
    },
    run: {
      findFirst: async () => null,
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { prisma: prisma as unknown as PrismaClient, interactions, effects };
}

function readyInteraction(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  return {
    id: "ix-1",
    spaceId: "space-1",
    threadId: "thread-1",
    runId: "run-1",
    intent: "email.compose",
    status: "ready_for_review",
    draftVersion: 2,
    confirmedVersion: null,
    plan,
    slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    title: "Send email",
    summary: null,
    approvalEffectId: null,
    messageId: null,
    ...overrides,
  };
}

describe("confirmInteractionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds an ExternalEffect whose request records both versions", async () => {
    const db = memoryPrisma(readyInteraction());
    const result = await confirmInteractionService(db.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
    });
    expect(result).toEqual({
      confirmedVersion: 2,
      effectId: "effect-1",
      idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
    });
    const effect = db.effects.get(result.idempotencyKey);
    expect(effect).toMatchObject({
      kind: "email.send",
      status: "intended",
      reviewDecision: "allow",
      request: {
        interactionId: "ix-1",
        intent: "email.compose",
        draftVersion: 2,
        confirmedVersion: 2,
        slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
      },
    });
    expect(db.interactions.get("ix-1")).toMatchObject({
      confirmedVersion: 2,
      status: "awaiting_approval",
      approvalEffectId: "effect-1",
    });
  });

  it("reuses the same effect when confirm is repeated for that version", async () => {
    const db = memoryPrisma(readyInteraction());
    const input = {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
    };
    const first = await confirmInteractionService(db.prisma, input);
    const second = await confirmInteractionService(db.prisma, input);
    expect(second.effectId).toBe(first.effectId);
    expect(db.effects.size).toBe(1);
  });

  it("refuses to confirm when there is no run to attach the effect to", async () => {
    const db = memoryPrisma(readyInteraction({ runId: null }));
    await expect(
      confirmInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        draftVersion: 2,
      }),
    ).rejects.toBeInstanceOf(InteractionEffectRunMissingError);
    expect(db.effects.size).toBe(0);
  });
});

describe("executeConfirmedInteractionService", () => {
  it("rejects send before the draft is confirmed", async () => {
    const db = memoryPrisma(readyInteraction());
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        interactionId: "ix-1",
      }),
    ).rejects.toBeInstanceOf(InteractionSendRejectedError);
  });

  it("rejects send after a later edit clears the confirmation", async () => {
    const db = memoryPrisma(
      readyInteraction({
        draftVersion: 3,
        confirmedVersion: 2,
        status: "ready_for_review",
        approvalEffectId: "effect-1",
      }),
    );
    db.effects.set("a2ui:interaction:ix-1:confirm:2", {
      id: "effect-1",
      spaceId: "space-1",
      runId: "run-1",
      kind: "email.send",
      idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      status: "intended",
      request: { draftVersion: 2, confirmedVersion: 2 },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        interactionId: "ix-1",
      }),
    ).rejects.toMatchObject({ code: "unconfirmed" });
  });

  it("accepts a confirmed draft without running a provider", async () => {
    const db = memoryPrisma(
      readyInteraction({
        status: "awaiting_approval",
        confirmedVersion: 2,
        approvalEffectId: "effect-1",
      }),
    );
    db.effects.set("a2ui:interaction:ix-1:confirm:2", {
      id: "effect-1",
      spaceId: "space-1",
      runId: "run-1",
      kind: "email.send",
      idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      status: "intended",
      request: {
        interactionId: "ix-1",
        intent: "email.compose",
        draftVersion: 2,
        confirmedVersion: 2,
        slots: {},
      },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        interactionId: "ix-1",
      }),
    ).resolves.toEqual({
      effectId: "effect-1",
      idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      duplicate: false,
      executed: false,
    });
  });

  it("does not execute a completed effect again", async () => {
    const db = memoryPrisma(
      readyInteraction({
        status: "succeeded",
        confirmedVersion: 2,
        approvalEffectId: "effect-1",
      }),
    );
    db.effects.set("key", {
      id: "effect-1",
      spaceId: "space-1",
      runId: "run-1",
      kind: "email.send",
      idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      status: "completed",
      request: { draftVersion: 2, confirmedVersion: 2 },
      reviewDecision: "allow",
      reviewReason: null,
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        interactionId: "ix-1",
      }),
    ).resolves.toMatchObject({ duplicate: true, executed: true, effectId: "effect-1" });
  });
});
