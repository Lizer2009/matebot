import type { InteractionPlan, InteractionSurfaceSchema } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { compileInteractionPlan } from "./compile.js";

/**
 * A draft must never publish as a card with no controls.
 *
 * The field report for the 2026-11-09 thread has a card whose persisted document contained
 * `Column` and three `Text` nodes and nothing else, while its data model still held the
 * draft's values. The compiler reached that shape by failing to build controls and then
 * falling back to a caption, so the caller saw a successful publish of a card nothing could
 * be typed into.
 *
 * These cases pin the two halves of the fix: a missing required value keeps the other fields
 * editable, and a real compile error is reported instead of being swallowed.
 */

const BODY = "正文".repeat(112);

const EMAIL_SCHEMA: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true, maxLength: 320 },
    { name: "cc", label: "CC", kind: "text", required: false, maxLength: 320 },
    { name: "subject", label: "Subject", kind: "text", required: true, maxLength: 400 },
    { name: "body", label: "Message", kind: "longText", required: true, maxLength: 20_000 },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
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

function dataModelValues(messages: unknown[]): Record<string, unknown> {
  for (const message of messages as Array<{ updateDataModel?: { value?: { values?: unknown } } }>) {
    const values = message.updateDataModel?.value?.values;
    if (values && typeof values === "object") return values as Record<string, unknown>;
  }
  return {};
}

/** The persisted plan from the field report: two key sets for the same three values. */
const R1_PLAN: InteractionPlan = {
  intent: "email.compose",
  title: "冬天的问候",
  fields: [
    { name: "to", required: true, status: "missing" },
    { name: "subject", required: true, status: "missing" },
    { name: "body", required: true, status: "missing" },
    { name: "To", value: "alex@example.test", required: true, status: "resolved" },
    { name: "Subject", value: "冬天的问候", required: true, status: "resolved" },
    { name: "Body", value: BODY, required: true, status: "resolved" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

describe("R1: a draft card never publishes with no controls", () => {
  it("keeps the registered fields editable when a required value is missing", async () => {
    const plan: InteractionPlan = {
      intent: "email.compose",
      title: "冬天的问候",
      fields: [
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        // body deliberately has no value, as when the user says "正文自理".
        { name: "body", required: true, status: "missing" },
      ],
      nextStep: "render",
      riskLevel: "medium",
    };
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "surface-missing-body",
      schema: EMAIL_SCHEMA,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const counts = kinds(result.messages as unknown[]);
    // Every declared field still gets an input; the empty one is simply empty.
    expect(counts.TextField ?? 0).toBe(4);
    expect(counts.Button ?? 0).toBe(1);
  });

  it("reports which required values are missing instead of only a caption", async () => {
    const plan: InteractionPlan = {
      intent: "email.compose",
      title: "冬天的问候",
      fields: [{ name: "to", required: true, status: "missing" }],
      nextStep: "render",
      riskLevel: "medium",
    };
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "surface-all-missing",
      schema: EMAIL_SCHEMA,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.missingRequired).toEqual(["to", "subject", "body"]);
  });

  it("does not leave two key sets for one field", async () => {
    const result = await compileInteractionPlan({
      plan: R1_PLAN,
      surfaceId: "surface-two-key-sets",
      schema: EMAIL_SCHEMA,
    });
    // Either the values are reconciled onto the registered names, or the plan is refused
    // with a reason. What must not happen is a published card holding both spellings.
    if (result.ok) {
      const keys = Object.keys(dataModelValues(result.messages as unknown[])).sort();
      expect(keys).toEqual(["body", "subject", "to"]);
      expect(kinds(result.messages as unknown[]).TextField ?? 0).toBe(4);
    } else {
      expect(result.error).toMatch(/field/i);
    }
  });
});

describe("R2: a real compile failure is reported, never published as a shell", () => {
  it("keeps a data field off the controls but out of neither the model nor the values", async () => {
    // A field the registered schema does not declare is data for the action, not a control:
    // a calendar batch list must not become a text box. It is still carried in the data model.
    const plan: InteractionPlan = {
      intent: "email.compose",
      title: "冬天的问候",
      fields: [
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: BODY, required: true, status: "resolved" },
        { name: "attachments", value: ["a.pdf"], required: false, status: "resolved" },
      ],
      nextStep: "render",
      riskLevel: "medium",
    };
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "surface-extra-field",
      schema: EMAIL_SCHEMA,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const counts = kinds(result.messages as unknown[]);
    // Four declared fields, no control for the extra one.
    expect(counts.TextField ?? 0).toBe(4);
    expect(JSON.stringify(result.messages)).not.toContain("/values/attachments");
  });

  it("refuses two spellings of one field that carry different values", async () => {
    // Silently choosing one would drop a value the user may have typed, so the plan is refused
    // and the caller can point at edit_interaction instead.
    const plan: InteractionPlan = {
      intent: "email.compose",
      title: "冬天的问候",
      fields: [
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "To", value: "someone-else@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: BODY, required: true, status: "resolved" },
      ],
      nextStep: "render",
      riskLevel: "medium",
    };
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "surface-conflict",
      schema: EMAIL_SCHEMA,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/conflicting values for field "to"/);
  });

  it("never returns a caption-only document for a registered form", async () => {
    const result = await compileInteractionPlan({
      plan: R1_PLAN,
      surfaceId: "surface-caption-only",
      schema: EMAIL_SCHEMA,
    });
    if (result.ok) {
      const counts = kinds(result.messages as unknown[]);
      expect(counts.TextField ?? 0).toBeGreaterThan(0);
      expect(counts.Button ?? 0).toBeGreaterThan(0);
    }
  });
});
