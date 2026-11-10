import { describe, expect, it, vi } from "vitest";

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    appendEventInTransaction: vi.fn(async () => ({ id: "event-1", seq: 1 })),
  };
});

import {
  interactionAppForProvider,
  interactionResumePrompt,
  resumeInteractionAfterConnection,
} from "./interaction-resume.js";

const plan = {
  intent: "calendar.create",
  title: "Create calendar",
  fields: [{ name: "name", required: true, status: "missing" }],
  nextStep: "ask",
  riskLevel: "medium",
};

type Row = { id: string; intent: string; status: string; draftVersion: number };

function fixture(options: { interactions?: Row[]; busy?: boolean; hasBot?: boolean } = {}) {
  const rows = (options.interactions ?? []).map((row) => ({
    ...row,
    confirmedVersion: null,
    plan,
    messageId: row.id === "ix-cal" ? "msg-cal" : null,
    title: "Create calendar",
    summary: null,
    runId: "run-1",
    surfaces: [{ surfaceId: `surf-${row.id}`, protocolFamily: "v0_9" }],
  }));
  const messages = new Map<string, { id: string; blocks: unknown[] }>([
    [
      "msg-cal",
      {
        id: "msg-cal",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-cal",
            surfaceId: "surf-ix-cal",
            protocolFamily: "v0_9",
            draftVersion: 1,
            capability: "not_connected",
          },
        ],
      },
    ],
  ]);
  const createdRuns: string[] = [];
  const events: string[] = [];
  let runSeq = 0;
  const tx = {
    $executeRaw: vi.fn(async () => undefined),
    interaction: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => messages.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: unknown[] } }) => {
          const row = messages.get(where.id);
          if (row) row.blocks = data.blocks;
        },
      ),
    },
    bot: {
      findFirst: vi.fn(async () => (options.hasBot === false ? null : { id: "bot-1" })),
    },
    run: {
      findFirst: vi.fn(async () => (options.busy ? { id: "busy-run" } : null)),
      create: vi.fn(async () => {
        runSeq += 1;
        const id = `run-new-${runSeq}`;
        createdRuns.push(id);
        return { id };
      }),
    },
    task: {
      create: vi.fn(async () => ({ id: "task-new" })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const enqueued: unknown[] = [];
  const deps = {
    prisma: prisma as never,
    jobs: {
      enqueue: async (job: unknown) => {
        enqueued.push(job);
      },
    },
  };
  return { deps, prisma, tx, messages, createdRuns, enqueued, events };
}

const actor = { spaceId: "space-1", userId: "user-1" };

describe("interactionAppForProvider", () => {
  it("knows which app a connected provider is", () => {
    expect(interactionAppForProvider("gmail")).toBe("email");
    expect(interactionAppForProvider("googlecalendar")).toBe("calendar");
    expect(interactionAppForProvider("google-calendar")).toBe("calendar");
    expect(interactionAppForProvider("notion")).toBeUndefined();
  });
});

describe("interactionResumePrompt", () => {
  it("asks for a calendar surface after the calendar connects", () => {
    const prompt = interactionResumePrompt({ app: "calendar", provider: "googlecalendar" });
    expect(prompt).toContain("present_interaction");
    expect(prompt).toContain('intent "calendar.create"');
    expect(prompt).toContain("name");
    expect(prompt).toContain("events");
  });

  it("asks for an email surface after the mailbox connects", () => {
    const prompt = interactionResumePrompt({ app: "email", provider: "gmail" });
    expect(prompt).toContain('intent "email.compose"');
    expect(prompt).toContain("to, subject, and body");
  });

  // The reported bug: the turn ended with prose asking for the calendar name.
  it("never asks for the fields in prose and never claims a result", () => {
    for (const app of ["calendar", "email"] as const) {
      const prompt = interactionResumePrompt({ app, provider: "gmail" });
      expect(prompt).toMatch(/Ask for nothing in prose/);
      expect(prompt).toMatch(/never claim the action happened/);
      expect(prompt).toMatch(/one short sentence/);
      // No credential tutorial: the connection is already done.
      expect(prompt).not.toMatch(/app password|SMTP|auth code/i);
    }
  });
});

describe("resumeInteractionAfterConnection", () => {
  it("makes a waiting calendar surface usable in place without a model turn", async () => {
    const f = fixture({
      interactions: [
        { id: "ix-cal", intent: "calendar.create", status: "needs_connection", draftVersion: 1 },
      ],
    });
    const result = await resumeInteractionAfterConnection(f.deps, {
      actor,
      botId: "bot-1",
      threadId: "thread-1",
      provider: "googlecalendar",
      appConnected: true,
    });
    expect(result).toEqual({ refreshedInteractionIds: ["ix-cal"], queuedRunId: null });
    expect(f.tx.interaction.updateMany).toHaveBeenCalledWith({
      where: { id: "ix-cal", draftVersion: 1 },
      data: { status: "collecting" },
    });
    expect(f.messages.get("msg-cal")?.blocks[0]).toMatchObject({
      capability: "ready",
      template: "email-draft-card",
      lifecycle: "draft",
    });
    expect(f.createdRuns).toEqual([]);
  });

  // The live gap: nothing waited on a surface, so the bot must be woken to build one.
  it("queues a resume turn when no surface was waiting", async () => {
    const f = fixture();
    const result = await resumeInteractionAfterConnection(f.deps, {
      actor,
      botId: "bot-1",
      threadId: "thread-1",
      provider: "googlecalendar",
      appConnected: true,
    });
    expect(result.refreshedInteractionIds).toEqual([]);
    expect(result.queuedRunId).toBe("run-new-1");
    expect(f.tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prompt: expect.stringContaining('intent "calendar.create"'),
        status: "queued",
      }),
    });
    expect(f.enqueued).toEqual([
      { name: "run.continue", payload: { runId: "run-new-1" }, replaceKey: "run:run-new-1" },
    ]);
  });

  it("starts nothing for an app no interaction can act through", async () => {
    const f = fixture();
    const result = await resumeInteractionAfterConnection(f.deps, {
      actor,
      botId: "bot-1",
      threadId: "thread-1",
      provider: "notion",
      appConnected: true,
    });
    expect(result).toEqual({ refreshedInteractionIds: [], queuedRunId: null });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("starts nothing when the app is catalogued but not actually connected", async () => {
    const f = fixture();
    const result = await resumeInteractionAfterConnection(f.deps, {
      actor,
      botId: "bot-1",
      threadId: "thread-1",
      provider: "googlecalendar",
      appConnected: false,
    });
    expect(result).toEqual({ refreshedInteractionIds: [], queuedRunId: null });
    expect(f.createdRuns).toEqual([]);
  });

  it("does not stack a run behind a busy bot", async () => {
    const f = fixture({ busy: true });
    const result = await resumeInteractionAfterConnection(f.deps, {
      actor,
      botId: "bot-1",
      threadId: "thread-1",
      provider: "googlecalendar",
      appConnected: true,
    });
    expect(result.queuedRunId).toBeNull();
    expect(f.createdRuns).toEqual([]);
  });

  it("leaves a waiting email surface alone when the calendar connects", async () => {
    const f = fixture({
      interactions: [
        { id: "ix-mail", intent: "email.compose", status: "needs_connection", draftVersion: 1 },
      ],
    });
    const result = await resumeInteractionAfterConnection(f.deps, {
      actor,
      botId: "bot-1",
      threadId: "thread-1",
      provider: "googlecalendar",
      appConnected: true,
    });
    expect(result.refreshedInteractionIds).toEqual([]);
  });

  it("starts nothing when the thread's outstanding card waits on another app", async () => {
    // The person connected their mailbox in a chat whose only unfinished card is waiting for the
    // calendar. No card was refreshed here, but that does not mean the chat was idle: a model
    // turn would ask for an email draft the person never abandoned, and would compete with the
    // calendar card still on screen waiting for its own connection.
    const f = fixture({
      interactions: [
        { id: "ix-cal", intent: "calendar.create", status: "needs_connection", draftVersion: 1 },
      ],
    });
    const result = await resumeInteractionAfterConnection(f.deps, {
      actor,
      botId: "bot-1",
      threadId: "thread-1",
      provider: "gmail",
      appConnected: true,
    });
    expect(result).toEqual({ refreshedInteractionIds: [], queuedRunId: null });
    expect(f.createdRuns).toEqual([]);
    expect(f.enqueued).toEqual([]);
  });
});
