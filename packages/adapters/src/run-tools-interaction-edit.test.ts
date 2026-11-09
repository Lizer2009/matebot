import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { editInteraction } from "./run-tools-interaction-edit.js";

/**
 * The tool handler the model actually calls. These exercise the production path:
 * a natural-language follow-up arrives as a tool call, the existing draft is
 * revised through the same field service, the same surface is republished, and
 * nothing is sent.
 */

const emailSchema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true },
    { name: "subject", label: "Subject", kind: "text", required: true },
    { name: "body", label: "Message", kind: "longText", required: true },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

type Row = {
  id: string;
  spaceId: string;
  threadId: string;
  intent: string;
  status: string;
  draftVersion: number;
  confirmedVersion: number | null;
  slots: Record<string, unknown>;
  title: string | null;
  /** The stored plan, which is what the readback reports rather than the request. */
  plan?: unknown;
};

function context(
  overrides: {
    rows?: Partial<Row>[];
    surfaces?: Array<{ taskId: string; surfaceId: string }>;
  } = {},
) {
  const rows: Row[] = (overrides.rows ?? [{}]).map((row, index) => ({
    id: index === 0 ? "ix-1" : `ix-${index + 1}`,
    spaceId: "space-1",
    threadId: "thread-1",
    intent: "email.compose",
    status: "ready_for_review",
    draftVersion: 2,
    confirmedVersion: null,
    slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    title: index === 0 ? "Email" : `Email ${index + 1}`,
    plan: {
      intent: "email.compose",
      title: "Email",
      fields: [
        { name: "to", value: "a@example.com", required: true, status: "resolved" },
        { name: "subject", value: "Hi", required: true, status: "resolved" },
        { name: "body", value: "Hello", required: true, status: "resolved" },
      ],
      nextStep: "render",
      riskLevel: "medium",
    },
    ...row,
  }));
  const surfaces =
    overrides.surfaces ?? rows.map((row) => ({ taskId: row.id, surfaceId: `surf-${row.id}` }));
  /** Republished surfaces, to prove one card moved rather than a second appeared. */
  const published: Array<{ interactionId: string; surfaceId: string; draftVersion: number }> = [];
  /** Every field write, in order. */
  const writes: Array<{
    interactionId: string;
    name: string;
    value: unknown;
    expectedDraftVersion: number;
  }> = [];

  const prisma = {
    interaction: {
      findMany: async () =>
        rows.map((row) => ({
          ...row,
          surfaces: surfaces
            .filter((surface) => surface.taskId === row.id)
            .map((surface) => ({ surfaceId: surface.surfaceId })),
        })),
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      updateMany: async () => ({ count: 1 }),
    },
    interactionSurface: {
      findFirst: async ({ where }: { where: { interactionId: string } }) => {
        const surface = surfaces.find((entry) => entry.taskId === where.interactionId);
        return surface
          ? {
              interactionId: surface.taskId,
              surfaceId: surface.surfaceId,
              protocolFamily: "v0_9",
              document: [],
            }
          : null;
      },
    },
    message: { findUnique: async () => ({ id: "msg-1", blocks: [] }), update: async () => ({}) },
    thread: { update: async () => ({ nextEventSeq: 2 }) },
    event: { create: async () => ({ id: "e", seq: 1 }) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    $executeRaw: async () => undefined,
  };

  const ctx = {
    deps: {
      prisma,
      events: { notify: async () => undefined },
      jobs: { enqueue: async () => undefined },
    },
    run: {
      id: "run-1",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
    },
    context: { userId: "user-1", signal: new AbortController().signal },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    state: { effects: { consumedIds: [] } },
  };

  const services = {
    loadInteraction: async (interactionId: string) => {
      const row = rows.find((entry) => entry.id === interactionId);
      return row
        ? {
            id: row.id,
            spaceId: row.spaceId,
            threadId: row.threadId,
            intent: row.intent,
            status: row.status,
            draftVersion: row.draftVersion,
            confirmedVersion: row.confirmedVersion,
            slots: row.slots,
            plan: row.plan,
          }
        : null;
    },
    listOpenSurfaces: async (input: { includeExecuted?: boolean }) =>
      rows
        .filter((row) => input.includeExecuted || row.status !== "succeeded")
        .map((row) => ({
          taskId: row.id,
          surfaceId: surfaces.find((surface) => surface.taskId === row.id)!.surfaceId,
          label: row.title ?? row.id,
          status: (row.status === "succeeded"
            ? "executed"
            : row.confirmedVersion !== null
              ? "approved"
              : "draft") as "draft" | "approved" | "executed",
          intent: row.intent,
        })),
    applyField: async (input: {
      interactionId: string;
      expectedDraftVersion: number;
      name: string;
      value: unknown;
    }) => {
      writes.push(input);
      const row = rows.find((entry) => entry.id === input.interactionId)!;
      row.slots = { ...row.slots, [input.name]: input.value };
      row.draftVersion += 1;
      row.confirmedVersion = null;
      published.push({
        interactionId: row.id,
        surfaceId: surfaces.find((surface) => surface.taskId === row.id)!.surfaceId,
        draftVersion: row.draftVersion,
      });
      return { draftVersion: row.draftVersion };
    },
  };

  return { ctx, rows, surfaces, published, writes, services, schema: emailSchema };
}

// The tool is gated on the feature flag, which ships off. These tests opt in
// explicitly, exactly as a deployment would.
beforeAll(() => vi.stubEnv("FEATURE_A2UI", "1"));
afterAll(() => vi.unstubAllEnvs());

describe("edit_interaction tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revises the existing draft and republishes the same surface", async () => {
    const h = context();
    const result = await editInteraction(
      h.ctx as never,
      { fields: { subject: "秋后问候" }, revision: 2 },
      h.services,
    );
    expect(result).toMatchObject({
      ok: true,
      interactionId: "ix-1",
      surfaceId: "surf-ix-1",
      draftVersion: 3,
    });
    expect(h.published).toEqual([
      { interactionId: "ix-1", surfaceId: "surf-ix-1", draftVersion: 3 },
    ]);
    expect(h.rows[0]?.slots.subject).toBe("秋后问候");
  });

  it("returns the one short Chinese nudge and never claims a send", async () => {
    const h = context();
    const result = await editInteraction(
      h.ctx as never,
      { fields: { subject: "秋后问候" }, revision: 2 },
      h.services,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.reply).toBeTruthy();
    expect(result.reply.length).toBeLessThanOrEqual(24);
    expect(result.reply).not.toMatch(/已发送|已创建|sent/i);
    expect(result).not.toHaveProperty("providerMessageId");
  });

  // The primary acceptance requirement: no send before the user confirms.
  it("does not execute anything, even when the field is the recipient", async () => {
    const h = context();
    await editInteraction(
      h.ctx as never,
      { fields: { to: "b@example.com" }, revision: 2 },
      h.services,
    );
    expect(h.rows[0]?.status).toBe("ready_for_review");
    expect(h.rows[0]?.slots.to).toBe("b@example.com");
  });

  it("refuses a stale revision without writing", async () => {
    const h = context({ rows: [{ draftVersion: 5 }] });
    const result = await editInteraction(
      h.ctx as never,
      { fields: { subject: "x" }, revision: 2 },
      h.services,
    );
    expect(result).toMatchObject({ ok: false, error: "stale_revision" });
    expect(h.writes).toEqual([]);
  });

  it("asks which card when several are open and none is named", async () => {
    const h = context({ rows: [{}, { title: "Email 2" }] });
    const result = await editInteraction(
      h.ctx as never,
      { fields: { subject: "x" }, revision: 2 },
      h.services,
    );
    expect(result).toMatchObject({ ok: false, error: "ambiguous_target" });
    if (result.ok) return;
    // The clarification names the candidates so the model can ask.
    expect(result.candidates?.length).toBe(2);
    expect(h.writes).toEqual([]);
  });

  it("edits the named card when the user specified one", async () => {
    const h = context({ rows: [{}, { title: "Email 2" }] });
    const result = await editInteraction(
      h.ctx as never,
      { interactionId: "ix-2", fields: { subject: "x" }, revision: 2 },
      h.services,
    );
    expect(result).toMatchObject({ ok: true, interactionId: "ix-2" });
  });

  it("refuses an executed card and points at a new draft", async () => {
    const h = context({ rows: [{ status: "succeeded" }] });
    const result = await editInteraction(
      h.ctx as never,
      { fields: { subject: "x" }, revision: 2 },
      h.services,
    );
    expect(result).toMatchObject({ ok: false, error: "already_executed" });
    expect(h.writes).toEqual([]);
  });

  it("rejects a field the card does not declare", async () => {
    const h = context();
    const result = await editInteraction(
      h.ctx as never,
      { fields: { apiKey: "sk-live" }, revision: 2 },
      h.services,
    );
    expect(result).toMatchObject({ ok: false, error: "unknown_field" });
    expect(h.writes).toEqual([]);
  });

  it("returns an error rather than throwing when the feature is off", async () => {
    const h = context();
    vi.stubEnv("FEATURE_A2UI", "0");
    const result = await editInteraction(
      h.ctx as never,
      { fields: { subject: "x" }, revision: 2 },
      h.services,
    );
    vi.unstubAllEnvs();
    expect(result).toMatchObject({ ok: false });
  });
});

describe("edit_interaction reports what the card holds afterwards", () => {
  beforeEach(() => {
    vi.stubEnv("FEATURE_A2UI", "1");
  });

  it("reads the stored row back instead of echoing the requested fields", async () => {
    // The write went through, but the row the tool reports must be the one on disk. If the
    // readback came from the request, a field the write skipped would still be reported as set.
    const harness = context({
      rows: [
        {
          plan: {
            intent: "email.compose",
            title: "Email",
            fields: [
              { name: "to", value: "a@example.com", required: true, status: "resolved" },
              { name: "subject", value: "旧主题", required: true, status: "resolved" },
              { name: "body", required: true, status: "missing" },
            ],
            nextStep: "render",
            riskLevel: "medium",
          },
          // The stored row reflects the write: the subject changed, the body is still empty.
          slots: { to: "a@example.com", subject: "旧主题" },
        },
      ],
    });
    const result = (await editInteraction(
      harness.ctx as never,
      { fields: { subject: "改过的主题" }, revision: 2 },
      harness.services,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.draftVersion).toBe(3);
    // The fields come from the stored plan and slots.
    expect(result.fields).toEqual([
      { name: "to", value: "a@example.com", required: true, filled: true },
      { name: "subject", value: "改过的主题", required: true, filled: true },
      { name: "body", value: "", required: true, filled: false },
    ]);
    expect(result.missingRequired).toEqual(["body"]);
    expect(result.actionable).toBe(false);
  });

  it("never reports a from field the card does not have", async () => {
    const harness = context();
    const result = (await editInteraction(
      harness.ctx as never,
      { fields: { subject: "新主题" }, revision: 2 },
      harness.services,
    )) as Record<string, unknown>;
    const names = (result.fields as Array<{ name: string }>).map((field) => field.name);
    expect(names).not.toContain("from");
    expect(names).not.toContain("sender");
  });
});
