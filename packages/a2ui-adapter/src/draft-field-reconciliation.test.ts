import type { InteractionField, InteractionPlan } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { canonicalPlanFields, compileInteractionPlan } from "./compile.js";

/**
 * The cases an independent review of the first P0 attempt turned up.
 *
 * Each one is a shape that either broke, or nearly broke, when the compiler started reconciling
 * field names and reporting missing values. They are kept together because they share a cause:
 * the compiler has callers that pass no registered schema at all (the field writer that
 * republishes a card after an edit, and the cancel path), so anything strict must stay confined
 * to the path that does have one.
 */

const EMAIL = {
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

const CALENDAR = {
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

function kinds(messages: unknown[]): string[] {
  const found: string[] = [];
  for (const message of messages as Array<{ updateComponents?: { components?: unknown[] } }>) {
    for (const component of message.updateComponents?.components ?? []) {
      const kind = (component as { component?: string })?.component;
      if (typeof kind === "string") found.push(kind);
    }
  }
  return found;
}

function fieldRows(messages: unknown[]): Array<{ name: string; value: unknown }> {
  for (const message of messages as Array<{ updateDataModel?: { value?: { fields?: unknown } } }>) {
    const rows = message.updateDataModel?.value?.fields;
    if (Array.isArray(rows)) return rows as Array<{ name: string; value: unknown }>;
  }
  return [];
}

const plan = (intent: string, fields: InteractionField[]): InteractionPlan => ({
  intent,
  title: "draft",
  fields,
  nextStep: "render",
  riskLevel: "medium",
});

describe("callers without a registered schema keep working", () => {
  it("does not refuse a calendar plan that carries a boolean allDay", async () => {
    // The field writer republishes after an edit and passes no schema, so every declared field
    // is compiled as text. A boolean there used to be skipped; making it fatal would turn every
    // calendar edit and cancel into a 500.
    const result = await compileInteractionPlan({
      plan: plan("calendar.create", [
        { name: "name", value: "Standup", required: true, status: "resolved" },
        { name: "allDay", value: false, required: false, status: "resolved" },
      ]),
      surfaceId: "no-schema-allDay",
    });
    expect(result.ok).toBe(true);
  });

  it("does not refuse a plan whose optional field holds an array", async () => {
    const result = await compileInteractionPlan({
      plan: plan("email.compose", [
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
        { name: "cc", value: [], required: false, status: "resolved" },
      ]),
      surfaceId: "optional-array",
      schema: EMAIL,
    });
    expect(result.ok).toBe(true);
  });

  it("still refuses a required field whose value cannot be read", async () => {
    // The guard is kept where it matters: a required value the action could not use is a real
    // mistake, not an optional field the model happened to leave in an odd shape.
    const result = await compileInteractionPlan({
      plan: plan("email.compose", [
        { name: "to", value: [], required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      surfaceId: "required-array",
      schema: EMAIL,
    });
    expect(result.ok).toBe(false);
  });
});

describe("blank required values are reported the way the confirm gate sees them", () => {
  for (const blank of ["", "   ", "\n"]) {
    it(`treats ${JSON.stringify(blank)} as a missing body`, async () => {
      const result = await compileInteractionPlan({
        plan: plan("email.compose", [
          { name: "to", value: "a@example.test", required: true, status: "resolved" },
          { name: "subject", value: "s", required: true, status: "resolved" },
          { name: "body", value: blank, required: true, status: "resolved" },
        ]),
        surfaceId: "blank-body",
        schema: EMAIL,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.missingRequired).toEqual(["body"]);
    });
  }
});

describe("the data model uses the schema's names, not the plan's", () => {
  it("rewrites Title-case field names onto the registered spelling", async () => {
    // The email editor reads its values by exact name from `fields`, so a plan spelled
    // TO/SUBJECT/BODY would render three empty inputs even though the controls held the values.
    const result = await compileInteractionPlan({
      plan: plan("email.compose", [
        { name: "TO", value: "a@example.test", required: true, status: "resolved" },
        { name: "SUBJECT", value: "s", required: true, status: "resolved" },
        { name: "BODY", value: "b", required: true, status: "resolved" },
      ]),
      surfaceId: "title-case",
      schema: EMAIL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const rows = fieldRows(result.messages);
    // Only the fields the plan supplied appear as rows; the optional cc has no value to record.
    expect(rows.map((row) => row.name).sort()).toEqual(["body", "subject", "to"]);
    expect(rows.find((row) => row.name === "to")?.value).toBe("a@example.test");
  });

  it("does not keep both spellings as separate rows", async () => {
    const result = await compileInteractionPlan({
      plan: plan("email.compose", [
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "To", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      surfaceId: "duplicate-rows",
      schema: EMAIL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(fieldRows(result.messages).map((row) => row.name)).toEqual(["to", "subject", "body"]);
  });
});

describe("an empty slot followed by the real value is not a conflict", () => {
  it("accepts the shape the normalisers produce", async () => {
    // `normalizeEmailComposePlan` inserts `to` with no value ahead of whatever the model sent,
    // so the common input is an empty placeholder followed by the value under another casing.
    // Refusing that would reject perfectly good drafts before the user ever saw a card.
    const result = await compileInteractionPlan({
      plan: plan("email.compose", [
        { name: "to", required: true, status: "missing" },
        { name: "To", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      surfaceId: "placeholder-then-value",
      schema: EMAIL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.missingRequired).toEqual([]);
    expect(fieldRows(result.messages).find((row) => row.name === "to")?.value).toBe(
      "a@example.test",
    );
  });
});

describe("a registered form is never published without controls", () => {
  it("draws the declared fields even when the plan listed none", async () => {
    const result = await compileInteractionPlan({
      plan: plan("email.compose", []),
      surfaceId: "no-fields",
      schema: EMAIL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(kinds(result.messages).filter((kind) => kind === "TextField")).toHaveLength(4);
    expect(result.missingRequired).toEqual(["to", "subject", "body"]);
  });

  it("draws the declared fields when the plan carried only undeclared ones", async () => {
    const result = await compileInteractionPlan({
      plan: plan("calendar.create", [
        { name: "events", value: [{ summary: "x" }], required: false, status: "resolved" },
      ]),
      surfaceId: "only-extra",
      schema: CALENDAR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(kinds(result.messages).filter((kind) => kind === "TextField").length).toBeGreaterThan(0);
  });
});

describe("duplicate undeclared names are a conflict too", () => {
  it("refuses two different values under one undeclared name", async () => {
    const result = await compileInteractionPlan({
      plan: plan("calendar.create", [
        { name: "name", value: "x", required: true, status: "resolved" },
        { name: "events", value: [{ a: 1 }], required: false, status: "resolved" },
        { name: "events", value: [{ b: 2 }], required: false, status: "resolved" },
      ]),
      surfaceId: "dup-extra",
      schema: CALENDAR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/conflicting values for field "events"/);
  });
});

describe("canonicalPlanFields", () => {
  it("keeps a field the schema does not declare as data", () => {
    const result = canonicalPlanFields(
      [
        { name: "name", value: "Two events", required: true, status: "resolved" },
        { name: "events", value: [{ summary: "Standup" }], required: false, status: "resolved" },
      ],
      CALENDAR,
    );
    expect(result.conflict).toBeUndefined();
    expect(result.fields.map((field) => field.name)).toEqual(["name"]);
    expect(result.extra.map((field) => field.name)).toEqual(["events"]);
  });

  it("reports a genuine two-value conflict", () => {
    const result = canonicalPlanFields(
      [
        { name: "To", value: "a@b.test", required: true, status: "resolved" },
        { name: "to", value: "c@d.test", required: true, status: "resolved" },
      ],
      EMAIL,
    );
    expect(result.conflict).toBe("to");
  });

  it("collapses three spellings that agree", () => {
    const result = canonicalPlanFields(
      [
        { name: "to", value: "a@b.test", required: true, status: "resolved" },
        { name: "To", value: "a@b.test", required: true, status: "resolved" },
        { name: "TO", value: "a@b.test", required: true, status: "resolved" },
      ],
      EMAIL,
    );
    expect(result.conflict).toBeUndefined();
    expect(result.fields.map((field) => field.name)).toEqual(["to"]);
  });
});
