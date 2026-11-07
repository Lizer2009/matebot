import type { InteractionPlan } from "@matebot/contracts";
import type { PrismaClient } from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Calendar create through the real execute service, with a provider double.
 *
 * This is the P1 claim in executable form: calendar is a second genuine domain on
 * the shared pipeline — same confirm, same claim, same ExternalEffect, same
 * finish projection — with its own validation and its own sender. No real
 * calendar is written; the "provider" records calls.
 */

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return { ...actual, appendEventInTransaction: vi.fn(async () => ({ id: "e", seq: 1 })) };
});

const calendarCreates: Array<Record<string, unknown>> = [];

vi.mock("@matebot/adapters", async () => {
  const actual = await vi.importActual<typeof import("@matebot/adapters")>("@matebot/adapters");
  return {
    ...actual,
    createCalendarEvent: vi.fn(async (draft: { event: Record<string, unknown> }) => {
      calendarCreates.push(draft.event);
      return { ok: true as const, eventId: "evt-1" };
    }),
  };
});

import { createCalendarEvent } from "@matebot/adapters";
import { executeConfirmedInteractionService } from "./interaction-service.js";

const plan: InteractionPlan = {
  intent: "calendar.create",
  title: "Create event",
  fields: [
    { name: "name", value: "Team sync", required: true, status: "resolved" },
    { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
    { name: "end", value: "2026-11-09T10:00:00+08:00", required: true, status: "resolved" },
  ],
  nextStep: "request_approval",
  riskLevel: "medium",
};

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

function harness(row: Partial<Row> = {}) {
  const interaction: Row = {
    id: "ix-cal",
    spaceId: "space-1",
    threadId: "thread-1",
    intent: "calendar.create",
    status: "awaiting_approval",
    draftVersion: 2,
    confirmedVersion: 2,
    plan,
    slots: {
      name: "Team sync",
      start: "2026-11-09T09:00:00+08:00",
      end: "2026-11-09T10:00:00+08:00",
    },
    title: "Create event",
    summary: null,
    approvalEffectId: "effect-cal",
    messageId: null,
    ...row,
  };
  const effect = {
    id: "effect-cal",
    spaceId: "space-1",
    runId: "run-1",
    kind: "calendar.create",
    idempotencyKey: "a2ui:interaction:ix-cal:confirm:2",
    status: "intended",
    request: {
      interactionId: "ix-cal",
      intent: "calendar.create",
      draftVersion: 2,
      confirmedVersion: 2,
      slots: interaction.slots,
    },
    reviewDecision: "allow",
    reviewReason: "user confirmed draft",
  };
  const tx = {
    interaction: {
      findUnique: async () => interaction,
      updateMany: async ({ data }: { data: Partial<Row> }) => {
        Object.assign(interaction, data);
        return { count: 1 };
      },
    },
    interactionSurface: { findFirst: async () => null },
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
  return { prisma, interaction, effect };
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
  calendarCreates.length = 0;
  vi.clearAllMocks();
});

describe("calendar create through the shared execute path", () => {
  it("creates the event once and reports success", async () => {
    const h = harness();
    const result = await executeConfirmedInteractionService(h.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-cal",
      ...readyCalendar,
    });
    expect(result).toMatchObject({ executed: true, duplicate: false, providerMessageId: "evt-1" });
    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(calendarCreates[0]).toMatchObject({ name: "Team sync" });
    expect(h.interaction.status).toBe("succeeded");
  });

  it("defaults the timezone to Asia/Shanghai when the draft omits one", async () => {
    const h = harness();
    await executeConfirmedInteractionService(h.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-cal",
      ...readyCalendar,
    });
    expect(calendarCreates[0]).toMatchObject({ timezone: "Asia/Shanghai" });
  });

  it("refuses to create when the calendar is not connected", async () => {
    const h = harness();
    await expect(
      executeConfirmedInteractionService(h.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-cal",
        ...readyCalendar,
        emailConnections: [],
      }),
    ).rejects.toMatchObject({ code: "needs_connection" });
    expect(createCalendarEvent).not.toHaveBeenCalled();
  });

  // The whole point of a second domain: a broken draft fails before any provider
  // call, and the interaction records the failure.
  it("fails before the provider when the event is invalid", async () => {
    const h = harness({
      slots: {
        name: "Bad",
        start: "2026-11-09T10:00:00+08:00",
        end: "2026-11-09T09:00:00+08:00",
      },
    });
    await expect(
      executeConfirmedInteractionService(h.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-cal",
        ...readyCalendar,
      }),
    ).rejects.toThrow(/Calendar event rejected/);
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(h.interaction.status).toBe("failed");
  });

  it("does not create a second event for an already-completed effect", async () => {
    const h = harness();
    h.effect.status = "completed";
    const result = await executeConfirmedInteractionService(h.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-cal",
      ...readyCalendar,
    });
    expect(result).toMatchObject({ duplicate: true, executed: true });
    expect(createCalendarEvent).not.toHaveBeenCalled();
  });

  it("never invites attendees, because the capability collects none", async () => {
    const h = harness();
    await executeConfirmedInteractionService(h.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-cal",
      ...readyCalendar,
    });
    expect(JSON.stringify(calendarCreates[0])).not.toMatch(/attendee|guest/i);
  });
});
