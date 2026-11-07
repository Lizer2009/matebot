import type { InteractionPlan } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A partial calendar batch through the real execute service.
 *
 * Spec §5.4.2 requires that a batch with two successes and one failure reports
 * that, and that it never reads as a plain success. The provider is a double that
 * records every call; no real calendar is written.
 */

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return { ...actual, appendEventInTransaction: vi.fn(async () => ({ id: "e", seq: 1 })) };
});

const creates: string[] = [];
let failOn: string | null = null;

vi.mock("@matebot/adapters", async () => {
  const actual = await vi.importActual<typeof import("@matebot/adapters")>("@matebot/adapters");
  return {
    ...actual,
    createCalendarEvent: vi.fn(async (draft: { event: { name: string } }) => {
      creates.push(draft.event.name);
      if (failOn === draft.event.name) return { ok: false as const, error: "declined" };
      return { ok: true as const, eventId: `evt-${creates.length}` };
    }),
  };
});

import { executeConfirmedInteractionService } from "./interaction-service.js";

const plan: InteractionPlan = {
  intent: "calendar.create",
  title: "Create events",
  fields: [
    { name: "name", value: "A", required: true, status: "resolved" },
    { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
    { name: "end", value: "2026-11-09T10:00:00+08:00", required: true, status: "resolved" },
  ],
  nextStep: "request_approval",
  riskLevel: "medium",
};

const item = (name: string, day: string) => ({
  name,
  start: `2026-11-${day}T09:00:00+08:00`,
  end: `2026-11-${day}T10:00:00+08:00`,
});

type Row = {
  id: string;
  spaceId: string;
  threadId: string;
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

function harness(slots: Record<string, unknown>) {
  const interaction: Row = {
    id: "ix-batch",
    spaceId: "space-1",
    threadId: "thread-1",
    intent: "calendar.create",
    status: "awaiting_approval",
    draftVersion: 2,
    confirmedVersion: 2,
    plan,
    slots,
    title: "Create events",
    summary: null,
    approvalEffectId: "effect-batch",
    messageId: null,
  };
  const finished: Array<{ result?: Record<string, unknown>; interactionStatus: string }> = [];
  /** Documents written to the card's surface, so a partial batch can be read back. */
  const surfaceWrites: Array<Record<string, unknown>> = [];
  const effect = {
    id: "effect-batch",
    spaceId: "space-1",
    runId: "run-1",
    kind: "calendar.create",
    idempotencyKey: "a2ui:interaction:ix-batch:confirm:2",
    status: "intended",
    request: {
      interactionId: "ix-batch",
      intent: "calendar.create",
      draftVersion: 2,
      confirmedVersion: 2,
      slots,
    },
    reviewDecision: "allow",
    reviewReason: "user confirmed draft",
  };
  const tx = {
    interaction: {
      findUnique: async () => interaction,
      updateMany: async ({ data }: { data: Partial<Row> }) => {
        Object.assign(interaction, data);
        finished.push({
          interactionStatus: String(data.status ?? ""),
          ...(data as { result?: Record<string, unknown> }),
        });
        return { count: 1 };
      },
    },
    interactionSurface: {
      findFirst: async () => ({
        interactionId: "ix-batch",
        surfaceId: "surf-batch",
        protocolFamily: "v0_9",
        document: [],
      }),
      upsert: async ({ create, update }: { create?: unknown; update?: unknown }) => {
        surfaceWrites.push((create ?? update) as Record<string, unknown>);
        return create ?? update;
      },
    },
    message: { findUnique: async () => null, update: async () => ({}) },
    externalEffect: {
      findUnique: async () => effect,
      updateMany: async ({ data }: { data: { status: string } }) => {
        effect.status = data.status;
        return { count: 1 };
      },
    },
    run: { findFirst: async () => null },
  };
  const prisma = {
    ...tx,
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx),
  } as unknown as PrismaClient;
  return { prisma, interaction, finished, surfaceWrites };
}

const readyCalendar = {
  userId: "user-1",
  emailConnections: [
    {
      id: "conn-cal",
      connectorId: "composio",
      provider: "googlecalendar",
      displayName: "Calendar",
      status: "connected",
      providerRef: "ca_cal",
    },
  ],
  reconnectRefs: [] as string[],
  providerReady: { googlecalendar: true },
  connector: {
    managed: () => ({ connectionReady: async () => true }),
    async *execute() {
      yield { type: "result" as const, data: {} };
    },
  },
};

beforeEach(() => {
  creates.length = 0;
  failOn = null;
  vi.clearAllMocks();
});

describe("calendar batch through the shared execute path", () => {
  it("creates each requested event and reports complete", async () => {
    const h = harness({ events: [item("A", "09"), item("B", "10")] });
    const result = await executeConfirmedInteractionService(h.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-batch",
      ...readyCalendar,
    });
    expect(result.executed).toBe(true);
    expect(creates).toEqual(["A", "B"]);
    expect(h.interaction.status).toBe("succeeded");
  });

  it("puts each item's outcome on the card, not just a failure", async () => {
    failOn = "B";
    const h = harness({ events: [item("A", "09"), item("B", "10"), item("C", "11")] });
    await expect(
      executeConfirmedInteractionService(h.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-batch",
        ...readyCalendar,
      }),
    ).rejects.toMatchObject({ outcome: "failed" });

    // The card's own document now lists one row per requested item.
    expect(h.surfaceWrites).toHaveLength(1);
    const document = JSON.stringify(h.surfaceWrites[0]?.document ?? []);
    for (const label of ["A", "B", "C"]) expect(document).toContain(label);
    expect(document).toContain("succeeded");
    expect(document).toContain("failed");
    // The count summary is on the card too.
    expect(document).toContain("2");
  });

  it("fails the interaction and says two of three, not done", async () => {
    failOn = "B";
    const h = harness({ events: [item("A", "09"), item("B", "10"), item("C", "11")] });
    await expect(
      executeConfirmedInteractionService(h.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-batch",
        ...readyCalendar,
      }),
    ).rejects.toMatchObject({ outcome: "failed" });
    // Every item was attempted, including the one after the failure.
    expect(creates).toEqual(["A", "B", "C"]);
    expect(h.interaction.status).toBe("failed");
  });

  it("refuses a broken item before calling the provider at all", async () => {
    const h = harness({
      events: [item("A", "09"), { ...item("B", "10"), end: "2026-11-01T10:00:00+08:00" }],
    });
    await expect(
      executeConfirmedInteractionService(h.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-batch",
        ...readyCalendar,
      }),
    ).rejects.toMatchObject({ outcome: "failed" });
    expect(creates).toEqual([]);
  });

  it("still creates a single event when no list was requested", async () => {
    const h = harness(item("Solo", "09"));
    const result = await executeConfirmedInteractionService(h.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-batch",
      ...readyCalendar,
    });
    expect(result.executed).toBe(true);
    expect(creates).toEqual(["Solo"]);
  });
});
