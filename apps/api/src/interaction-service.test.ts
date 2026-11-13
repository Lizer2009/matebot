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

vi.mock("@matebot/adapters", async () => {
  const actual = await vi.importActual<typeof import("@matebot/adapters")>("@matebot/adapters");
  return {
    ...actual,
    deliverInteractionEmail: vi.fn(async () => ({ ok: true, deliveryId: "msg-1" })),
    inspectInteractionEmailDelivery: vi.fn(),
    reconcileAmbiguousEmailEffect: vi.fn(),
  };
});

import { deliverInteractionEmail, reconcileAmbiguousEmailEffect } from "@matebot/adapters";
import { appendEventInTransaction } from "@matebot/db";
import {
  confirmInteractionService,
  executeConfirmedInteractionService,
  InteractionEffectRunMissingError,
  InteractionEmailDeliveryError,
  InteractionSendRejectedError,
  reconcileConfirmedInteractionService,
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
  staleAt: Date | null;
  expiresAt?: Date | null;
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
  result?: Record<string, unknown> | null;
};

function memoryPrisma(
  interaction: InteractionRecord,
  extras?: {
    surface?: { surfaceId: string; protocolFamily: string };
    message?: { id: string; blocks: unknown[] };
  },
) {
  const interactions = new Map<string, InteractionRecord>([[interaction.id, interaction]]);
  const effects = new Map<string, EffectRecord>();
  const messages = new Map<string, { id: string; blocks: unknown[] }>();
  if (extras?.message) messages.set(extras.message.id, extras.message);
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
      findFirst: async () =>
        extras?.surface
          ? {
              interactionId: interaction.id,
              surfaceId: extras.surface.surfaceId,
              protocolFamily: extras.surface.protocolFamily,
            }
          : null,
    },
    message: {
      findUnique: async ({ where }: { where: { id: string } }) => messages.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { blocks: unknown[] } }) => {
        const row = messages.get(where.id);
        if (!row) throw new Error("message update was not expected");
        row.blocks = data.blocks;
        return row;
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
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Partial<EffectRecord>;
      }) => {
        const effect = [...effects.values()].find(
          (row) =>
            row.id === where.id && (where.status === undefined || row.status === where.status),
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
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
  return { prisma: prisma as unknown as PrismaClient, interactions, effects, messages };
}

function eventTypes(): string[] {
  return vi
    .mocked(appendEventInTransaction)
    .mock.calls.map((call) => (call[1] as { type: string }).type);
}

function lastSurfacePayload(): Record<string, unknown> | undefined {
  const calls = vi
    .mocked(appendEventInTransaction)
    .mock.calls.filter((call) => (call[1] as { type: string }).type === "thread.surface.updated");
  const last = calls.at(-1);
  return last ? (last[1] as { payload: Record<string, unknown> }).payload : undefined;
}

function confirmedDraft(extras?: {
  surface?: { surfaceId: string; protocolFamily: string };
  message?: { id: string; blocks: unknown[] };
}) {
  const interaction = readyInteraction({
    status: "awaiting_approval",
    confirmedVersion: 2,
    approvalEffectId: "effect-1",
    messageId: extras?.message?.id ?? null,
  });
  const db = memoryPrisma(interaction, extras);
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
      slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    },
    reviewDecision: "allow",
    reviewReason: "user confirmed draft",
  });
  return db;
}

const readyMailbox = {
  userId: "user-1",
  emailConnections: [
    {
      id: "conn-gmail",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Mail",
      status: "connected",
      providerRef: "ca_1",
    },
  ],
  reconnectRefs: [] as string[],
  connector: {
    async *execute() {
      yield { type: "result" as const, data: { data: { messageId: "msg-1" } } };
    },
  },
};

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
    staleAt: null,
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
      ...readyMailbox,
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
    expect(db.interactions.get("ix-1")?.expiresAt).toBeInstanceOf(Date);
  });

  it("clears staleAt so run-end settle cannot supersede a confirmed card", async () => {
    const mark = new Date("2026-11-14T00:00:00.000Z");
    const db = memoryPrisma(readyInteraction({ staleAt: mark }));
    await confirmInteractionService(db.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
      ...readyMailbox,
    });
    expect(db.interactions.get("ix-1")?.staleAt).toBeNull();
  });

  it("reuses the same effect when confirm is repeated for that version", async () => {
    const db = memoryPrisma(readyInteraction());
    const input = {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
      ...readyMailbox,
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
        ...readyMailbox,
      }),
    ).rejects.toBeInstanceOf(InteractionEffectRunMissingError);
    expect(db.effects.size).toBe(0);
  });

  it("refuses a terminal interaction with a confirm-not-allowed message", async () => {
    const db = memoryPrisma(
      readyInteraction({ status: "succeeded", confirmedVersion: 2, approvalEffectId: "effect-1" }),
    );
    await expect(
      confirmInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        draftVersion: 2,
        ...readyMailbox,
      }),
    ).rejects.toThrow(/cannot be confirmed/);
  });

  it("refuses to confirm when no mailbox is connected", async () => {
    const db = memoryPrisma(readyInteraction());
    await expect(
      confirmInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        draftVersion: 2,
        ...readyMailbox,
        emailConnections: [],
      }),
    ).rejects.toMatchObject({ code: "needs_connection" });
    expect(db.effects.size).toBe(0);
  });
});

describe("executeConfirmedInteractionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // An effect kind this build has no sender for must never be reported as run.
  // This replaces the retired `resolveInteractionSender` helper: the behaviour
  // lives in this service now, so it is checked here rather than in a module
  // nothing calls.
  it("reports an unknown effect kind as not executed", async () => {
    const db = memoryPrisma(
      readyInteraction({ confirmedVersion: 2, approvalEffectId: "effect-1" }),
    );
    db.effects.set("a2ui:interaction:ix-1:confirm:2", {
      id: "effect-1",
      spaceId: "space-1",
      runId: "run-1",
      kind: "reminder.create",
      idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      status: "intended",
      request: {
        interactionId: "ix-1",
        intent: "reminder.create",
        draftVersion: 2,
        confirmedVersion: 2,
        slots: {},
      },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    const result = await executeConfirmedInteractionService(db.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      ...readyMailbox,
    });
    expect(result).toMatchObject({ executed: false, duplicate: false });
  });

  it("rejects send before the draft is confirmed", async () => {
    const db = memoryPrisma(readyInteraction());
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
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
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toMatchObject({ code: "unconfirmed" });
  });

  it("sends a confirmed email draft and completes the effect", async () => {
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
        slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
      },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).resolves.toEqual({
      effectId: "effect-1",
      idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      duplicate: false,
      executed: true,
      providerMessageId: "msg-1",
    });
    expect(deliverInteractionEmail).toHaveBeenCalledWith(
      {
        to: "a@example.com",
        subject: "Hi",
        body: "Hello",
        idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
      },
      expect.objectContaining({
        kind: "connector",
        connectionId: "conn-gmail",
        context: expect.objectContaining({ userId: "user-1", spaceId: "space-1" }),
      }),
    );
    expect(db.effects.get("a2ui:interaction:ix-1:confirm:2")).toMatchObject({
      status: "completed",
      result: { deliveryId: "msg-1" },
    });
    expect(db.interactions.get("ix-1")?.status).toBe("succeeded");
  });

  it("rejects a confirmed draft that has no recipient and keeps the effect failed", async () => {
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: false,
      error: "A recipient is required",
    });
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
        draftVersion: 2,
        confirmedVersion: 2,
        slots: { to: "", subject: "Hi", body: "Hello" },
      },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toBeInstanceOf(InteractionEmailDeliveryError);
    expect(db.effects.get("a2ui:interaction:ix-1:confirm:2")?.status).toBe("failed");
    expect(db.interactions.get("ix-1")?.status).toBe("failed");
  });

  it("does not resend an in-flight effect; E′ reconciles ambiguous outcomes", async () => {
    const db = memoryPrisma(
      readyInteraction({
        status: "executing",
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
      status: "ambiguous",
      request: {
        draftVersion: 2,
        confirmedVersion: 2,
        slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
      },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toMatchObject({ code: "unconfirmed" });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
    expect(db.effects.get("a2ui:interaction:ix-1:confirm:2")?.status).toBe("ambiguous");
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
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).resolves.toMatchObject({ duplicate: true, executed: true, effectId: "effect-1" });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
  });

  it("rejects send when no mailbox is connected", async () => {
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
      request: { draftVersion: 2, confirmedVersion: 2 },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
        emailConnections: [],
      }),
    ).rejects.toMatchObject({ code: "needs_connection" });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
  });

  it("rejects send when the mailbox requires reauth", async () => {
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
      request: { draftVersion: 2, confirmedVersion: 2 },
      reviewDecision: "allow",
      reviewReason: "user confirmed draft",
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
        emailConnections: [
          {
            id: "conn-gmail",
            connectorId: "composio",
            provider: "gmail",
            displayName: "Mail",
            status: "error",
            providerRef: "ca_expired",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "needs_connection" });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
  });

  it("patches the existing surface through progress then success", async () => {
    const db = confirmedDraft({
      surface: { surfaceId: "surf-1", protocolFamily: "v0_9" },
      message: {
        id: "msg-surface",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion: 2,
            confirmedVersion: 2,
            intent: "email.compose",
            capability: "ready",
            template: "email-draft-card",
          },
        ],
      },
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).resolves.toMatchObject({ executed: true, providerMessageId: "msg-1" });
    expect(eventTypes()).toContain("thread.interaction.action_started");
    expect(eventTypes()).toContain("thread.interaction.action_progress");
    expect(eventTypes()).toContain("thread.interaction.action_succeeded");
    expect(lastSurfacePayload()).toMatchObject({
      template: "action-result-success",
      lifecycle: "succeeded",
      providerMessageId: "msg-1",
      capability: "ready",
    });
    expect(db.messages.get("msg-surface")?.blocks[0]).toMatchObject({
      kind: "a2ui_surface",
      template: "action-result-success",
      lifecycle: "succeeded",
      providerMessageId: "msg-1",
    });
    expect(db.interactions.get("ix-1")?.status).toBe("succeeded");
  });

  it("patches a failed send onto the same surface with a retryable failed template", async () => {
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: false,
      error: "Could not send the email",
    });
    const db = confirmedDraft({
      surface: { surfaceId: "surf-1", protocolFamily: "v0_9" },
      message: {
        id: "msg-surface",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion: 2,
            capability: "ready",
          },
        ],
      },
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toBeInstanceOf(InteractionEmailDeliveryError);
    expect(eventTypes()).toContain("thread.interaction.action_failed");
    expect(lastSurfacePayload()).toMatchObject({
      template: "action-result-failed",
      lifecycle: "failed",
    });
    expect(db.effects.get("a2ui:interaction:ix-1:confirm:2")?.status).toBe("failed");
    expect(db.interactions.get("ix-1")?.status).toBe("failed");
  });

  it("keeps an ambiguous effect and UNKNOWN surface on timeout", async () => {
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: false,
      error: "Request timed out",
      outcome: "unknown",
    });
    const db = confirmedDraft({
      surface: { surfaceId: "surf-1", protocolFamily: "v0_9" },
      message: {
        id: "msg-surface",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion: 2,
            capability: "ready",
          },
        ],
      },
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(lastSurfacePayload()).toMatchObject({
      template: "action-reconcile-card",
      lifecycle: "unknown",
    });
    expect(db.effects.get("a2ui:interaction:ix-1:confirm:2")?.status).toBe("ambiguous");
    expect(db.interactions.get("ix-1")?.status).toBe("unknown");
  });

  it("enqueues a reconcile job on timeout and does not send again", async () => {
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: false,
      error: "Request timed out",
      outcome: "unknown",
    });
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const db = confirmedDraft();
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        jobs,
        ...readyMailbox,
      }),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "action.reconcile",
        payload: { effectId: "effect-1" },
      }),
    );
    expect(deliverInteractionEmail).toHaveBeenCalledTimes(1);
  });

  it("lets Check status inspect without calling send", async () => {
    vi.mocked(reconcileAmbiguousEmailEffect).mockResolvedValueOnce({
      status: "succeeded",
      providerMessageId: "prov-found",
    });
    const db = confirmedDraft();
    db.interactions.get("ix-1")!.status = "unknown";
    db.effects.get("a2ui:interaction:ix-1:confirm:2")!.status = "ambiguous";
    await expect(
      reconcileConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).resolves.toEqual({
      effectId: "effect-1",
      status: "succeeded",
      providerMessageId: "prov-found",
    });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
  });

  it("maps an unexpected provider throw to a failed effect instead of leaving executing", async () => {
    vi.mocked(deliverInteractionEmail).mockRejectedValueOnce(new Error("Internal server error"));
    const db = confirmedDraft({
      surface: { surfaceId: "surf-1", protocolFamily: "v0_9" },
      message: {
        id: "msg-surface",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion: 2,
            capability: "ready",
          },
        ],
      },
    });
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toBeInstanceOf(InteractionEmailDeliveryError);
    expect(lastSurfacePayload()).toMatchObject({
      template: "action-result-failed",
      lifecycle: "failed",
    });
    expect(db.effects.get("a2ui:interaction:ix-1:confirm:2")?.status).toBe("failed");
    expect(db.interactions.get("ix-1")?.status).toBe("failed");
  });

  it("maps a post-claim crash to a failed surface instead of a bare 500", async () => {
    const db = confirmedDraft({
      surface: { surfaceId: "surf-1", protocolFamily: "v0_9" },
      message: {
        id: "msg-surface",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion: 2,
            capability: "ready",
          },
        ],
      },
    });
    vi.spyOn(db.prisma, "$transaction").mockRejectedValueOnce(new Error("Internal server error"));
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toMatchObject({
      name: "InteractionEmailDeliveryError",
      message: "Could not send the email",
    });
    expect(lastSurfacePayload()).toMatchObject({
      template: "action-result-failed",
      lifecycle: "failed",
    });
    expect(db.effects.get("a2ui:interaction:ix-1:confirm:2")?.status).toBe("failed");
    expect(db.interactions.get("ix-1")?.status).toBe("failed");
  });

  it("retries a failed send on the same confirmed effect", async () => {
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: false,
      error: "Could not send the email",
    });
    const db = confirmedDraft({
      surface: { surfaceId: "surf-1", protocolFamily: "v0_9" },
      message: {
        id: "msg-surface",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion: 2,
            confirmedVersion: 2,
            capability: "ready",
          },
        ],
      },
    });
    const input = {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      ...readyMailbox,
    };
    await expect(executeConfirmedInteractionService(db.prisma, input)).rejects.toBeInstanceOf(
      InteractionEmailDeliveryError,
    );
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: true,
      deliveryId: "msg-retry",
    });
    await expect(executeConfirmedInteractionService(db.prisma, input)).resolves.toMatchObject({
      executed: true,
      providerMessageId: "msg-retry",
    });
    expect(lastSurfacePayload()).toMatchObject({
      template: "action-result-success",
      lifecycle: "succeeded",
      providerMessageId: "msg-retry",
    });
    expect(db.interactions.get("ix-1")?.status).toBe("succeeded");
  });

  it("refuses a second send after UNKNOWN so the user cannot resend", async () => {
    const db = confirmedDraft();
    db.interactions.get("ix-1")!.status = "unknown";
    db.effects.get("a2ui:interaction:ix-1:confirm:2")!.status = "ambiguous";
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toMatchObject({ code: "unknown" });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
  });

  it("refuses Send when the effect is already ambiguous", async () => {
    const db = confirmedDraft();
    db.effects.get("a2ui:interaction:ix-1:confirm:2")!.status = "ambiguous";
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toMatchObject({ code: "unknown" });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
  });
});

/** The live failure: the local row still said connected after the provider revoked it. */
const staleMailbox = {
  ...readyMailbox,
  reconnectRefs: ["ca_1"],
  providerReady: { gmail: false },
};

function surfaceDraft() {
  return confirmedDraft({
    surface: { surfaceId: "surf-1", protocolFamily: "v0_9" },
    message: {
      id: "msg-surface",
      blocks: [
        {
          kind: "a2ui_surface",
          interactionId: "ix-1",
          surfaceId: "surf-1",
          protocolFamily: "v0_9",
          draftVersion: 2,
          capability: "ready",
        },
      ],
    },
  });
}

describe("inactive mailbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses Send and turns the same card into reconnect when the provider says dead", async () => {
    const db = surfaceDraft();
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...staleMailbox,
      }),
    ).rejects.toMatchObject({ code: "needs_connection" });
    expect(deliverInteractionEmail).not.toHaveBeenCalled();
    expect(lastSurfacePayload()).toMatchObject({
      template: "email-reauth-card",
      capability: "requires_reauth",
    });
    expect(db.interactions.get("ix-1")?.status).toBe("needs_connection");
  });

  it("refuses Connect-time confirm the same way, without creating an effect", async () => {
    const db = memoryPrisma(readyInteraction());
    await expect(
      confirmInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        draftVersion: 2,
        ...staleMailbox,
      }),
    ).rejects.toMatchObject({ code: "needs_connection" });
    expect(db.effects.size).toBe(0);
  });

  // The card must stay actionable: a dead Connector account is a reconnect, not a
  // failure the user can only read about while the model explains SMTP.
  it("maps the connector's dead-account error onto reconnect, not retry", async () => {
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: false,
      error: "The gmail connection is no longer active. Ask the user to reconnect gmail.",
    });
    const db = surfaceDraft();
    await expect(
      executeConfirmedInteractionService(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        ...readyMailbox,
      }),
    ).rejects.toBeInstanceOf(InteractionEmailDeliveryError);
    expect(lastSurfacePayload()).toMatchObject({
      template: "email-reauth-card",
      capability: "requires_reauth",
      lifecycle: "failed",
    });
  });

  it("retries a failed send after the mailbox is usable again", async () => {
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({
      ok: false,
      error: "The gmail connection is no longer active. Ask the user to reconnect gmail.",
    });
    const db = surfaceDraft();
    const input = {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      ...readyMailbox,
    };
    await expect(executeConfirmedInteractionService(db.prisma, input)).rejects.toBeInstanceOf(
      InteractionEmailDeliveryError,
    );
    vi.mocked(deliverInteractionEmail).mockResolvedValueOnce({ ok: true, deliveryId: "msg-2" });
    // The user reconnected; Retry preflights again and succeeds on the same effect.
    await expect(executeConfirmedInteractionService(db.prisma, input)).resolves.toMatchObject({
      providerMessageId: "msg-2",
    });
    expect(lastSurfacePayload()).toMatchObject({ template: "action-result-success" });
  });
});

describe("confirmInteractionService on a row written before reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirms a draft whose values sit under the model's own spellings", async () => {
    // Rows written by a build that stored the plan unreconciled carry `To`/`Subject`/`Body`.
    // The gate reads the schema's names, so without reconciling on the way in the person is
    // told their complete draft is missing fields, with no way to repair it.
    const db = memoryPrisma(
      readyInteraction({
        plan: {
          intent: "email.compose",
          title: "Send email",
          fields: [
            { name: "to", required: true, status: "missing" },
            { name: "subject", required: true, status: "missing" },
            { name: "body", required: true, status: "missing" },
            { name: "To", value: "a@example.com", required: true, status: "resolved" },
            { name: "Subject", value: "Hi", required: true, status: "resolved" },
            { name: "Body", value: "Hello", required: true, status: "resolved" },
          ],
          nextStep: "request_approval",
          riskLevel: "medium",
        },
        slots: { To: "a@example.com", Subject: "Hi", Body: "Hello" },
      }),
    );
    const result = await confirmInteractionService(db.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      draftVersion: 2,
      ...readyMailbox,
    });
    expect(result.confirmedVersion).toBe(2);
    const effect = db.effects.get(result.idempotencyKey);
    // The effect carries the schema's names, which is what the deliverer reads.
    expect(effect).toMatchObject({
      request: { slots: { to: "a@example.com", subject: "Hi", body: "Hello" } },
    });
  });
});
