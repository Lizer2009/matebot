import type { InteractionField, InteractionPlan } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { canonicalPlanFields, compileInteractionPlan } from "./compile.js";

/**
 * The production compiler, wired to the registered schema, on the two shapes the field audit
 * found: a draft with an empty required field, and a plan whose field names disagree with the
 * registry's spelling.
 *
 * These are service-level in the sense that matters here: they drive the same entry point the
 * publish path calls, with the same schema the capability registry hands it, and read the
 * document it produces. What they do not exercise is the database write — that is covered by
 * the adapters' publish tests.
 */

const EMAIL_SCHEMA = {
  schemaVersion: 1 as const,
  presentation: "form" as const,
  fields: [
    { name: "to", label: "To", kind: "email" as const, required: true, maxLength: 320 },
    { name: "cc", label: "CC", kind: "text" as const, required: false, maxLength: 320 },
    { name: "subject", label: "Subject", kind: "text" as const, required: true, maxLength: 400 },
    {
      name: "body",
      label: "Message",
      kind: "longText" as const,
      required: true,
      maxLength: 20_000,
    },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

const CALENDAR_SCHEMA = {
  schemaVersion: 1 as const,
  presentation: "form" as const,
  fields: [
    { name: "name", label: "Name", kind: "text" as const, required: true, maxLength: 200 },
    { name: "start", label: "Starts", kind: "dateTime" as const, required: true },
    { name: "end", label: "Ends", kind: "dateTime" as const, required: true },
    { name: "timezone", label: "Time zone", kind: "text" as const, required: false, maxLength: 64 },
    { name: "allDay", label: "All day", kind: "boolean" as const, required: false },
  ],
  action: { id: "create", label: "Create", requiresRevision: true },
};

function kinds(messages: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages as Array<{ updateComponents?: { components?: unknown[] } }>) {
    for (const component of message.updateComponents?.components ?? []) {
      const kind = (component as { component?: string })?.component;
      if (typeof kind === "string") counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return counts;
}

function values(messages: unknown[]): Record<string, unknown> {
  for (const message of messages as Array<{ updateDataModel?: { value?: { values?: unknown } } }>) {
    const found = message.updateDataModel?.value?.values;
    if (found && typeof found === "object") return found as Record<string, unknown>;
  }
  return {};
}

describe("registered schema drives the compiled card", () => {
  it("email: every declared field is editable, and the empty ones are named", async () => {
    const plan: InteractionPlan = {
      intent: "email.compose",
      title: "冬天的问候",
      fields: [
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "body", required: true, status: "missing" },
      ],
      nextStep: "render",
      riskLevel: "medium",
    };
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "email-1",
      schema: EMAIL_SCHEMA,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    // Four declared fields, so the optional cc is drawn empty alongside the required three.
    expect(kinds(result.messages).TextField).toBe(4);
    expect(kinds(result.messages).Button).toBe(1);
    expect(result.missingRequired).toEqual(["body"]);
    // The data model uses the schema's names, which is what the controls bind to.
    expect(Object.keys(values(result.messages)).sort()).toEqual(["subject", "to"]);
  });

  it("calendar: an empty name still renders the date fields", async () => {
    const plan: InteractionPlan = {
      intent: "calendar.create",
      title: "Next week",
      fields: [
        { name: "name", required: true, status: "missing" },
        { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
        { name: "end", value: "2026-11-09T09:30:00+08:00", required: true, status: "resolved" },
      ],
      nextStep: "render",
      riskLevel: "medium",
    };
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "calendar-1",
      schema: CALENDAR_SCHEMA,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(kinds(result.messages).TextField).toBeGreaterThan(0);
    expect(kinds(result.messages).Button).toBe(1);
    expect(result.missingRequired).toEqual(["name"]);
  });

  it("legacy fallback: a plan with no registered schema still compiles", async () => {
    // Callers without a capability schema keep working; their fields become text controls.
    const plan: InteractionPlan = {
      intent: "unregistered.thing",
      title: "Something",
      fields: [
        { name: "a", value: "1", required: true, status: "resolved" },
        { name: "b", required: false, status: "missing" },
      ],
      nextStep: "render",
      riskLevel: "low",
    };
    const result = await compileInteractionPlan({ plan, surfaceId: "legacy-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(kinds(result.messages).TextField).toBe(2);
    expect(result.missingRequired).toEqual([]);
  });
});

describe("canonicalPlanFields", () => {
  it("merges two spellings that carry the same value onto the registered name", () => {
    const plan: { fields: InteractionField[] } = {
      fields: [
        { name: "To", value: "a@b.test", required: true, status: "resolved" as const },
        { name: "to", value: "a@b.test", required: true, status: "resolved" as const },
      ],
    };
    const result = canonicalPlanFields(plan.fields, EMAIL_SCHEMA);
    expect(result.conflict).toBeUndefined();
    expect(result.fields.map((field) => field.name)).toEqual(["to"]);
    expect(result.fields[0]?.value).toBe("a@b.test");
  });

  it("reports a conflict when the two spellings disagree", () => {
    const plan: { fields: InteractionField[] } = {
      fields: [
        { name: "To", value: "a@b.test", required: true, status: "resolved" as const },
        { name: "to", value: "c@d.test", required: true, status: "resolved" as const },
      ],
    };
    expect(canonicalPlanFields(plan.fields, EMAIL_SCHEMA).conflict).toBe("to");
  });

  it("keeps a field the schema does not declare as data rather than dropping it", () => {
    const plan: { fields: InteractionField[] } = {
      fields: [
        { name: "name", value: "Two events", required: true, status: "resolved" as const },
        {
          name: "events",
          value: [{ summary: "Standup" }],
          required: false,
          status: "resolved" as const,
        },
      ],
    };
    const result = canonicalPlanFields(plan.fields, CALENDAR_SCHEMA);
    expect(result.conflict).toBeUndefined();
    expect(result.fields.map((field) => field.name)).toEqual(["name"]);
    expect(result.extra.map((field) => field.name)).toEqual(["events"]);
  });
});
