import { reconcilePlanToSchema } from "@matebot/a2ui-adapter";
import type { InteractionField, InteractionPlan } from "@matebot/contracts";
import { InteractionFieldSchema, MAX_UNDECLARED_FIELD_BYTES } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { emailDraftSlots } from "./interaction-email-outcome.js";

/**
 * What an undeclared field may carry, and what it may never reach.
 *
 * A plan can name fields the registered schema does not declare, and those are kept as data for
 * the action — a calendar batch list is the case that needs it. That is a real extension point,
 * not a licence: the values the send path treats as authority (the sending mailbox, the
 * connection, the tool that runs, the execution parameters) come from the server's own records,
 * never from a plan field however it is named.
 */

const EMAIL_SCHEMA = {
  schemaVersion: 1 as const,
  presentation: "form" as const,
  fields: [
    { name: "to", label: "To", kind: "email" as const, required: true },
    { name: "cc", label: "CC", kind: "text" as const, required: false },
    { name: "subject", label: "Subject", kind: "text" as const, required: true },
    { name: "body", label: "Message", kind: "longText" as const, required: true },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

const plan = (fields: InteractionField[]): InteractionPlan => ({
  intent: "email.compose",
  title: "draft",
  fields,
  nextStep: "render",
  riskLevel: "medium",
});

describe("the send path reads only the three declared values", () => {
  it("ignores a slot named sender, from, connection or tool", () => {
    // The deliverer builds its mailbox from the connection row, so a plan field cannot choose
    // who the mail comes from however it is spelled.
    const slots = {
      to: "alex@example.test",
      subject: "hi",
      body: "text",
      sender: "attacker@example.test",
      from: "attacker@example.test",
      connectionId: "someone-elses-connection",
      tool: "GMAIL_DELETE_ALL",
      providerRef: "forged",
      connectorId: "forged",
      account: "someone-else",
    };
    expect(emailDraftSlots({ slots })).toEqual({
      to: "alex@example.test",
      subject: "hi",
      body: "text",
    });
  });

  it("returns empty strings rather than echoing an unexpected type", () => {
    const slots = { to: 42, subject: ["a"], body: { text: "x" } };
    expect(emailDraftSlots({ slots })).toEqual({ to: "", subject: "", body: "" });
  });
});

describe("undeclared fields stay data, within a bound", () => {
  const base: InteractionField[] = [
    { name: "to", value: "a@example.test", required: true, status: "resolved" },
    { name: "subject", value: "s", required: true, status: "resolved" },
    { name: "body", value: "b", required: true, status: "resolved" },
  ];

  it("keeps a small one and drops no declared field", () => {
    const result = reconcilePlanToSchema(
      plan([
        ...base,
        {
          name: "attachments",
          value: [{ name: "a.pdf", size: 12 }],
          required: false,
          status: "resolved",
        },
      ]),
      EMAIL_SCHEMA,
    );
    expect(result.conflict).toBeUndefined();
    expect(result.oversizedField).toBeUndefined();
    expect(result.plan.fields.map((field) => field.name)).toContain("attachments");
    expect(result.plan.fields.map((field) => field.name)).toContain("to");
  });

  it("refuses one larger than a draft may carry", () => {
    const big = "x".repeat(MAX_UNDECLARED_FIELD_BYTES + 1);
    const result = reconcilePlanToSchema(
      plan([...base, { name: "payload", value: big, required: false, status: "resolved" }]),
      EMAIL_SCHEMA,
    );
    expect(result.oversizedField).toBe("payload");
  });

  it("does not bound a declared field, which the schema already caps", () => {
    // `body` has its own maxLength; the undeclared limit must not double-guard it.
    const body = "y".repeat(MAX_UNDECLARED_FIELD_BYTES + 1);
    const result = reconcilePlanToSchema(
      plan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: body, required: true, status: "resolved" },
      ]),
      EMAIL_SCHEMA,
    );
    expect(result.oversizedField).toBeUndefined();
  });
});

describe("a plan field name is bounded", () => {
  it("rejects a very long name before it reaches storage", () => {
    const longName = "n".repeat(500);
    expect(
      InteractionFieldSchema.safeParse({ name: longName, required: false, status: "missing" })
        .success,
    ).toBe(false);
  });

  it("accepts an ordinary name", () => {
    expect(
      InteractionFieldSchema.safeParse({ name: "attachments", required: false, status: "missing" })
        .success,
    ).toBe(true);
  });
});
