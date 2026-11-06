import type { ConnectorProvider } from "@matebot/adapter-kit";
import type { PrismaClient } from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectInteractionEmailDelivery } from "./interaction-email.js";
import { finishInteractionEmailSend } from "./interaction-email-outcome.js";
import {
  EMAIL_RECONCILE_DEADLINE_MS,
  enqueueEmailReconcile,
  reconcileAmbiguousEmailEffect,
  reconcileAmbiguousEmailEffects,
} from "./interaction-email-reconcile.js";

vi.mock("./interaction-email.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interaction-email.js")>()),
  inspectInteractionEmailDelivery: vi.fn(),
}));

vi.mock("./interaction-email-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interaction-email-outcome.js")>()),
  finishInteractionEmailSend: vi.fn(async () => true),
}));

const inspect = vi.mocked(inspectInteractionEmailDelivery);
const finish = vi.mocked(finishInteractionEmailSend);

const plan = {
  intent: "email.compose",
  title: "Send email",
  fields: [],
  nextStep: "request_approval" as const,
  riskLevel: "medium" as const,
};

function deps(status: { interaction: string; effect: string; updatedAt?: Date }) {
  const enqueued: unknown[] = [];
  const effect = {
    id: "effect-1",
    kind: "email.send",
    status: status.effect,
    idempotencyKey: "a2ui:interaction:ix-1:confirm:2",
    request: {
      slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    },
    runId: "run-1",
    updatedAt: status.updatedAt ?? new Date(),
    run: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
  };
  const interaction = {
    id: "ix-1",
    spaceId: "space-1",
    threadId: "thread-1",
    status: status.interaction,
    draftVersion: 2,
    confirmedVersion: 2,
    plan,
    messageId: "msg-surface",
    title: "Send email",
    summary: null,
    approvalEffectId: "effect-1",
  };
  const prisma = {
    externalEffect: {
      findUnique: async () => effect,
    },
    interaction: {
      findFirst: async () => interaction,
      findMany: async () =>
        status.interaction === "unknown" ? [{ approvalEffectId: "effect-1" }] : [],
    },
    connection: {
      findMany: async () => [
        {
          id: "conn-gmail",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Mail",
          status: "connected",
          providerRef: "ca_1",
        },
      ],
    },
  } as unknown as PrismaClient;
  const connector = { execute: async function* () {} } as unknown as ConnectorProvider;
  return {
    prisma,
    jobs: {
      enqueue: vi.fn(async (job: unknown) => {
        enqueued.push(job);
      }),
    },
    connector,
    enqueued,
    effect,
    interaction,
  };
}

describe("reconcileAmbiguousEmailEffect", () => {
  beforeEach(() => {
    inspect.mockReset();
    finish.mockClear();
  });

  it("ignores an in-flight send so it cannot race the API hot path", async () => {
    const env = deps({ interaction: "executing", effect: "ambiguous" });
    await expect(reconcileAmbiguousEmailEffect(env, { effectId: "effect-1" })).resolves.toEqual({
      status: "ignored",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("finishes SUCCEEDED when SENT evidence exists and never sends", async () => {
    inspect.mockResolvedValueOnce({ found: true, deliveryId: "prov-found" });
    const env = deps({ interaction: "unknown", effect: "ambiguous" });
    await expect(reconcileAmbiguousEmailEffect(env, { effectId: "effect-1" })).resolves.toEqual({
      status: "succeeded",
      providerMessageId: "prov-found",
    });
    expect(finish).toHaveBeenCalledWith(
      env.prisma,
      expect.objectContaining({
        effectStatus: "reconciled",
        interactionStatus: "succeeded",
        expectedEffectStatus: "ambiguous",
      }),
    );
    expect(env.enqueued).toEqual([]);
  });

  it("keeps UNKNOWN and re-queues when inspect times out", async () => {
    inspect.mockResolvedValueOnce({
      found: false,
      outcome: "unknown",
      error: "Request timed out",
    });
    const env = deps({ interaction: "unknown", effect: "ambiguous" });
    await expect(reconcileAmbiguousEmailEffect(env, { effectId: "effect-1" })).resolves.toEqual({
      status: "unknown",
    });
    expect(finish).not.toHaveBeenCalled();
    expect(env.enqueued).toEqual([
      expect.objectContaining({
        name: "action.reconcile",
        payload: { effectId: "effect-1" },
      }),
    ]);
  });

  it("keeps UNKNOWN and re-queues when SENT is empty before the deadline", async () => {
    inspect.mockResolvedValueOnce({ found: false });
    const env = deps({ interaction: "unknown", effect: "ambiguous" });
    await expect(reconcileAmbiguousEmailEffect(env, { effectId: "effect-1" })).resolves.toEqual({
      status: "unknown",
    });
    expect(finish).not.toHaveBeenCalled();
    expect(env.enqueued).toEqual([
      expect.objectContaining({
        name: "action.reconcile",
        payload: { effectId: "effect-1" },
      }),
    ]);
  });

  it("fails only after a successful empty inspect past the deadline", async () => {
    inspect.mockResolvedValueOnce({ found: false });
    const env = deps({
      interaction: "unknown",
      effect: "ambiguous",
      updatedAt: new Date(Date.now() - EMAIL_RECONCILE_DEADLINE_MS - 1),
    });
    await expect(reconcileAmbiguousEmailEffect(env, { effectId: "effect-1" })).resolves.toEqual({
      status: "failed",
    });
    expect(finish).toHaveBeenCalledWith(
      env.prisma,
      expect.objectContaining({
        effectStatus: "failed",
        interactionStatus: "failed",
      }),
    );
  });
});

describe("reconcileAmbiguousEmailEffects", () => {
  it("re-enqueues UNKNOWN rows and not in-flight claims", async () => {
    const env = deps({ interaction: "unknown", effect: "ambiguous" });
    await reconcileAmbiguousEmailEffects(env);
    expect(env.enqueued).toEqual([
      expect.objectContaining({ name: "action.reconcile", payload: { effectId: "effect-1" } }),
    ]);
  });
});

describe("enqueueEmailReconcile", () => {
  it("no-ops without a publisher", async () => {
    await expect(enqueueEmailReconcile(undefined, "effect-1")).resolves.toBeUndefined();
  });
});
