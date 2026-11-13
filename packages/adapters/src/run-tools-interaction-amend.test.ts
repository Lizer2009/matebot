import { buildAmendment } from "@matebot/core";
import { describe, expect, it, vi } from "vitest";
import { editInteraction, servicesFor } from "./run-tools-interaction-edit.js";

vi.stubEnv("FEATURE_A2UI", "1");

/**
 * Correcting a record that already ran.
 *
 * The executed row is a record of what happened, so a correction may not edit it.
 * These drive the real tool with the real service deps: the original row must be
 * untouched afterwards, and a new draft must exist that names it and carries the
 * amended value. Nothing is executed by the correction itself.
 */

const executedPlan = {
  intent: "email.compose",
  title: "Email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved", source: "user" },
    { name: "subject", value: "Hi", required: true, status: "resolved", source: "thread" },
    { name: "body", value: "Hello", required: true, status: "resolved", source: "thread" },
  ],
  nextStep: "execute",
  riskLevel: "medium",
};

function harness() {
  const written: Array<Record<string, unknown>> = [];
  const original = {
    id: "ix-done",
    spaceId: "space-1",
    threadId: "thread-1",
    intent: "email.compose",
    status: "succeeded",
    draftVersion: 4,
    confirmedVersion: 4,
    slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    plan: executedPlan,
    title: "Email",
    summary: null,
    messageId: "msg-1",
    runId: null,
  };
  const snapshot = JSON.stringify(original);

  const prisma = {
    interaction: {
      // The open-card lookup filters by status; a succeeded row can never match it, and a
      // fake that ignores the filter would look like a card the kernel is allowed to amend.
      findFirst: async ({ where }: { where: { status?: { in?: string[] } } }) =>
        where.status?.in?.includes(original.status) ? original : null,
      findMany: async () => [],
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === original.id
          ? original
          : ((written.find((row) => row.id === where.id) as typeof original | undefined) ?? null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          id: "ix-amended",
          draftVersion: 1,
          confirmedVersion: null,
        };
        written.push(row);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
      update: async () => original,
    },
    interactionSurface: {
      findFirst: async () => ({
        interactionId: "ix-amended",
        surfaceId: "surf-amended",
        protocolFamily: "v0_9",
        document: [],
      }),
      upsert: async () => ({
        surface: { interactionId: "ix-amended", surfaceId: "surf-amended" },
        documentRef: "a2ui:interaction:ix-amended:surface:surf-amended",
      }),
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "msg-new", ...data }),
      findUnique: async () => null,
      update: async () => ({}),
    },
    thread: { update: async () => ({ nextEventSeq: 2 }) },
    run: {
      findUnique: async () => ({
        id: "run-1",
        status: "running",
        leaseOwner: null,
        firstResponseAt: null,
      }),
      // A published surface counts as first feedback, so the event write records it.
      updateMany: async () => ({ count: 1 }),
    },
    // A connected mailbox, so the capability stamp the correction reports is a real one rather
    // than an empty object from a lookup that failed.
    connection: {
      findMany: async () => [
        {
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          status: "connected",
          providerRef: "acct-1",
        },
      ],
    },
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
  } as never;

  return { ctx, written, original, snapshot };
}

describe("correcting an executed record", () => {
  it("creates a linked draft and leaves the executed row byte-for-byte intact", async () => {
    const h = harness();
    const result = await editInteraction(
      h.ctx,
      { interactionId: "ix-done", revision: 4, fields: { subject: "Corrected" } },
      servicesFor(h.ctx),
    );
    expect(result).toMatchObject({ ok: true, amendment: true, interactionId: "ix-amended" });
    // The record of what happened did not change.
    expect(JSON.stringify(h.original)).toBe(h.snapshot);
    // A new draft exists, carries the amended value, and names the record.
    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toMatchObject({ status: "ready_for_review" });
    const plan = h.written[0]?.plan as { fields: Array<{ name: string; value: unknown }> };
    expect(plan.fields.find((field) => field.name === "subject")?.value).toBe("Corrected");
  });

  it("describes the new draft from what was stored, including the value it is missing", async () => {
    // A correction that leaves a required value out must not be reported as complete. This is the
    // readback the amendment returns, and it has to come from the stored plan rather than from
    // the fields the model asked to change — those are the same words the old card used.
    const h = harness();
    const result = await editInteraction(
      h.ctx,
      { interactionId: "ix-done", revision: 4, fields: { subject: "" } },
      servicesFor(h.ctx),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    // An empty subject is stored empty, so the readback names it as the gap.
    expect(result.fields?.find((field: { name: string }) => field.name === "subject")?.filled).toBe(
      false,
    );
    expect(result.missingRequired).toContain("subject");
    expect(result.actionable).toBe(false);
    expect(result.blockedBy).toContain("subject");
    // A correction is never actionable on its own: its confirmation belongs to the new card.
    expect(result.confirmationInvalidated).toBe(true);
  });

  it("publishes the mailbox stamp it reports, so the card and the result agree", async () => {
    // The correction's readback names a capability and a sender. If the draft it published
    // carried neither, the card on screen would contradict the sentence the model was given.
    const h = harness();
    const seen: Array<Record<string, unknown>> = [];
    const services = servicesFor(h.ctx);
    const result = await editInteraction(
      h.ctx,
      { interactionId: "ix-done", revision: 4, fields: { subject: "Corrected" } },
      {
        ...services,
        publishAmendment: async (input) => {
          seen.push(input as unknown as Record<string, unknown>);
          return services.publishAmendment!(input);
        },
      },
    );
    expect(result.ok).toBe(true);
    // The stamp reaches the publisher, which is what puts it on the block.
    expect(seen[0]?.capabilityStamp).toEqual({ capability: "ready", senderLabel: "Gmail" });
  });

  it("says the correction still needs its own confirmation", async () => {
    const h = harness();
    const result = await editInteraction(
      h.ctx,
      { interactionId: "ix-done", revision: 4, fields: { subject: "Corrected" } },
      servicesFor(h.ctx),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confirmationInvalidated).toBe(true);
    expect(result.reply).toContain("关联草稿");
    // It never claims the correction ran.
    expect(result.reply).not.toContain("已发送");
  });

  it("protects a field the person typed even in a correction", async () => {
    const h = harness();
    const result = await editInteraction(
      h.ctx,
      { interactionId: "ix-done", revision: 4, fields: { to: "other@example.com" } },
      servicesFor(h.ctx),
    );
    expect(result).toMatchObject({ ok: false, error: "no_change" });
    expect(h.written).toHaveLength(0);
  });
});

describe("buildAmendment", () => {
  const schema = {
    schemaVersion: 1 as const,
    presentation: "form" as const,
    fields: [
      { name: "subject", label: "Subject", kind: "text" as const, required: true },
      { name: "body", label: "Message", kind: "longText" as const, required: true },
    ],
    action: { id: "send", label: "Send", requiresRevision: true },
  };

  it("changes only the named fields", () => {
    const built = buildAmendment({
      plan: executedPlan,
      fields: { subject: "New" },
      schema,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.changedFields).toEqual(["subject"]);
    expect(built.plan.fields.find((field) => field.name === "body")?.value).toBe("Hello");
  });

  it("refuses a field the schema does not declare", () => {
    expect(
      buildAmendment({ plan: executedPlan, fields: { bcc: "x@example.com" }, schema }),
    ).toEqual({ ok: false, error: "unknown_field" });
  });
});
