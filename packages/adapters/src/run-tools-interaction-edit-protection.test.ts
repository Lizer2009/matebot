import { describe, expect, it, vi } from "vitest";
import { userEditedFieldNames } from "@matebot/core";
import { editInteraction, servicesFor } from "./run-tools-interaction-edit.js";

/**
 * Spec §6.4.3 — a late model edit must not overwrite a field the person typed.
 *
 * These drive the real `editInteraction` tool with the real `servicesFor`
 * dependency builder, so field protection has to come from the persisted draft
 * rather than from an argument a caller remembers to pass. Only the database and
 * the field write are stubbed; the real Postgres proof lives in
 * `apps/api/src/a2ui-route-postgres.test.ts`.
 */

vi.stubEnv("FEATURE_A2UI", "1");

const typedRecipientPlan = {
  intent: "email.compose",
  title: "Email",
  fields: [
    { name: "to", value: "typed@example.com", required: true, status: "resolved", source: "user" },
    { name: "subject", value: "Hi", required: true, status: "resolved", source: "thread" },
    { name: "body", value: "Hello", required: true, status: "resolved", source: "thread" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

const modelOnlyPlan = {
  ...typedRecipientPlan,
  fields: typedRecipientPlan.fields.map((field) => ({ ...field, source: "thread" })),
};

function harness(plan: unknown, draftVersion = 3) {
  const writes: Array<{ name: string; value: unknown; expectedDraftVersion: number }> = [];
  const row = {
    id: "ix-1",
    spaceId: "space-1",
    threadId: "thread-1",
    intent: "email.compose",
    status: "ready_for_review",
    draftVersion,
    confirmedVersion: null,
    slots: { to: "typed@example.com", subject: "Hi", body: "Hello" },
    plan,
    title: "Email",
    summary: null,
    messageId: "msg-1",
    runId: "run-1",
  };
  const prisma = {
    interaction: {
      findMany: async () => [{ ...row, surfaces: [{ surfaceId: "surf-1" }] }],
      findUnique: async () => row,
    },
  };
  const ctx = {
    deps: { prisma, events: {}, jobs: {} },
    run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId: "u1" },
    context: { userId: "u1", signal: new AbortController().signal },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    state: { effects: { consumedIds: [] } },
  } as never;
  const services = servicesFor(ctx);
  return {
    ctx,
    writes,
    services: {
      ...services,
      applyField: async (input: Parameters<typeof services.applyField>[0]) => {
        writes.push({
          name: input.name,
          value: input.value,
          expectedDraftVersion: input.expectedDraftVersion,
        });
        return { draftVersion: input.expectedDraftVersion + 1 };
      },
    },
  };
}

describe("userEditedFieldNames", () => {
  it("reads only the fields stamped as user-written", () => {
    expect(userEditedFieldNames(typedRecipientPlan)).toEqual(["to"]);
  });

  it("treats a missing or malformed plan as nothing protected", () => {
    expect(userEditedFieldNames(undefined)).toEqual([]);
    expect(userEditedFieldNames({ fields: "nope" })).toEqual([]);
    expect(userEditedFieldNames(modelOnlyPlan)).toEqual([]);
  });
});

describe("edit_interaction protects fields the person typed", () => {
  it("skips a user-stamped field without being told which", async () => {
    const { ctx, services, writes } = harness(typedRecipientPlan);
    const result = await editInteraction(
      ctx,
      { fields: { to: "model@example.com", subject: "Updated" }, revision: 3 },
      services,
    );
    expect(result.ok).toBe(true);
    expect(writes.map((write) => write.name)).toEqual(["subject"]);
    expect(writes[0]?.value).toBe("Updated");
    if (result.ok) expect(result.skippedFields).toEqual(["to"]);
  });

  it("applies the same edit once nothing is user-stamped", async () => {
    const { ctx, services, writes } = harness(modelOnlyPlan);
    const result = await editInteraction(
      ctx,
      { fields: { to: "model@example.com", subject: "Updated" }, revision: 3 },
      services,
    );
    expect(result.ok).toBe(true);
    expect(writes.map((write) => write.name).sort()).toEqual(["subject", "to"]);
  });

  it("refuses a stale revision before touching any field", async () => {
    const { ctx, services, writes } = harness(typedRecipientPlan);
    const result = await editInteraction(
      ctx,
      { fields: { subject: "Updated" }, revision: 1 },
      services,
    );
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("treats a user-edited field as already matching, so it is not rewritten", async () => {
    const { ctx, services, writes } = harness({
      ...typedRecipientPlan,
      fields: typedRecipientPlan.fields.map((field) =>
        field.name === "to" ? { ...field, value: "typed@example.com" } : field,
      ),
    });
    const result = await editInteraction(
      ctx,
      { fields: { to: "typed@example.com" }, revision: 3 },
      services,
    );
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(0);
  });
});
