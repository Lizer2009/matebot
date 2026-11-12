import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import {
  compileInteractionSurface,
  INTERACTION_ACTION_EVENT,
  surfaceDataModel,
} from "./compile-surface.js";

/**
 * These assert the compiled tree, not a snapshot of today's output. The old
 * compiler emitted Column + three Text for every plan, which passed every
 * schema check and still gave the user nothing to type into. Each test below
 * fails if the tree stops containing a real control.
 */

const schema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true },
    { name: "subject", label: "Subject", kind: "text", required: true },
    { name: "body", label: "Message", kind: "longText", required: false },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

const values = { to: "a@example.com", subject: "Hi", body: "" };

function componentsOf(messages: unknown[]): Array<Record<string, unknown>> {
  const update = messages.find(
    (message) => (message as { updateComponents?: unknown }).updateComponents,
  ) as { updateComponents: { components: Array<Record<string, unknown>> } } | undefined;
  return update?.updateComponents.components ?? [];
}

function byId(components: Array<Record<string, unknown>>, id: string) {
  return components.find((component) => component.id === id);
}

describe("compileInteractionSurface", () => {
  it("emits a TextField per text-like field bound to the data model", async () => {
    const result = await compileInteractionSurface({ schema, values, surfaceId: "s-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const components = componentsOf(result.messages);
    const fields = components.filter((component) => component.component === "TextField");
    expect(fields).toHaveLength(3);
    expect(fields[0]).toMatchObject({
      label: "To",
      value: { path: `/values/to` },
      variant: "shortText",
    });
    expect(fields[2]).toMatchObject({ label: "Message", variant: "longText" });
  });

  it("emits one primary Button whose action carries the allowlisted name", async () => {
    const result = await compileInteractionSurface({ schema, values, surfaceId: "s-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const components = componentsOf(result.messages);
    const buttons = components.filter((component) => component.component === "Button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      variant: "primary",
      action: {
        event: {
          name: `${INTERACTION_ACTION_EVENT}.send`,
          // Bound, not literal: the click must carry this revision.
          context: {
            interactionId: { path: "/interactionId" },
            revision: { path: "/revision" },
          },
        },
      },
    });
    // The label is a child Text, per the spec's Button shape.
    const label = byId(components, String(buttons[0]?.child));
    expect(label).toMatchObject({ component: "Text", text: "Send" });
  });

  it("renders a choice field as ChoicePicker with declared options only", async () => {
    const result = await compileInteractionSurface({
      surfaceId: "s-choice",
      values: { visibility: "team" },
      schema: {
        schemaVersion: 1,
        presentation: "form",
        fields: [
          {
            name: "visibility",
            label: "Visibility",
            kind: "choice",
            required: true,
            options: [
              { value: "private", label: "Only me" },
              { value: "team", label: "Team" },
            ],
          },
        ],
        action: { id: "save", label: "Save", requiresRevision: true },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const picker = componentsOf(result.messages).find(
      (component) => component.component === "ChoicePicker",
    );
    expect(picker).toMatchObject({
      label: "Visibility",
      value: { path: "/values/visibility" },
    });
    expect(picker?.options).toEqual([
      { value: "private", label: "Only me" },
      { value: "team", label: "Team" },
    ]);
  });

  it("renders dateTime as DateTimeInput and boolean as CheckBox", async () => {
    const result = await compileInteractionSurface({
      surfaceId: "s-dt",
      values: { start: "2026-11-09T09:00:00+08:00", allDay: true },
      schema: {
        schemaVersion: 1,
        presentation: "form",
        fields: [
          { name: "start", label: "Starts", kind: "dateTime", required: true },
          { name: "allDay", label: "All day", kind: "boolean", required: false },
        ],
        action: { id: "create", label: "Create", requiresRevision: true },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const components = componentsOf(result.messages);
    expect(byId(components, "field_start")).toMatchObject({
      component: "DateTimeInput",
      value: { path: "/values/start" },
    });
    expect(byId(components, "field_allDay")).toMatchObject({
      component: "CheckBox",
      value: { path: "/values/allDay" },
    });
  });

  // A result surface shows data; it must not sprout an editable control or an action.
  it("renders a result surface with no inputs and no action button", async () => {
    const result = await compileInteractionSurface({
      surfaceId: "s-result",
      values: {},
      schema: {
        schemaVersion: 1,
        presentation: "result",
        fields: [],
        action: null,
      },
      result: {
        title: "Revenue",
        provenance: {
          source: "user-provided CSV",
          asOf: "2026-11-06T00:00:00.000Z",
          units: "CNY",
        },
        columns: [
          { key: "quarter", label: "Quarter" },
          { key: "total", label: "Total" },
        ],
        rows: [
          { quarter: "Q1", total: "1.2M" },
          { quarter: "Q2", total: "1.6M" },
        ],
        truncated: false,
        totalRows: 2,
        empty: false,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const components = componentsOf(result.messages);
    expect(components.some((component) => component.component === "TextField")).toBe(false);
    expect(components.some((component) => component.component === "Button")).toBe(false);
    const texts = components
      .filter((component) => component.component === "Text")
      .map((component) => component.text);
    // The header labels, the cell values, and the provenance line all render.
    expect(texts).toContain("Quarter");
    expect(texts).toContain("Q1");
    expect(texts).toContain("1.2M");
    expect(
      texts.some((text) => typeof text === "string" && text.includes("user-provided CSV")),
    ).toBe(true);
  });

  // An empty result must say so rather than render an empty grid.
  it("renders an empty result as a sentence, not a table", async () => {
    const result = await compileInteractionSurface({
      surfaceId: "s-empty",
      values: {},
      schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
      result: {
        title: "Revenue",
        provenance: { source: "user-provided CSV", asOf: "2026-11-06T00:00:00.000Z" },
        columns: [],
        rows: [],
        truncated: false,
        totalRows: 0,
        empty: true,
        emptyNotice: "No data was found for this period in user-provided CSV.",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const texts = componentsOf(result.messages)
      .filter((component) => component.component === "Text")
      .map((component) => component.text);
    expect(texts).toContain("No data was found for this period in user-provided CSV.");
  });

  it("refuses a schema with an unknown field kind instead of emitting a broken tree", async () => {
    const result = await compileInteractionSurface({
      surfaceId: "s-bad",
      values: {},
      schema: {
        schemaVersion: 1,
        presentation: "form",
        // Deliberately outside InteractionFieldKind.
        fields: [{ name: "x", label: "X", kind: "richText" as never, required: true }],
        action: { id: "go", label: "Go", requiresRevision: true },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an action id outside the allowlist", async () => {
    const result = await compileInteractionSurface({
      surfaceId: "s-act",
      values: {},
      schema: {
        schemaVersion: 1,
        presentation: "form",
        fields: [{ name: "a", label: "A", kind: "text", required: false }],
        action: { id: "deleteEverything", label: "Go", requiresRevision: true },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a form that declares no action and a result that declares one", async () => {
    const formNoAction = await compileInteractionSurface({
      surfaceId: "s-a",
      values: {},
      schema: { schemaVersion: 1, presentation: "form", fields: [], action: null },
    });
    expect(formNoAction.ok).toBe(false);

    const resultWithAction = await compileInteractionSurface({
      surfaceId: "s-b",
      values: {},
      schema: {
        schemaVersion: 1,
        presentation: "result",
        fields: [],
        action: { id: "send", label: "Send", requiresRevision: true },
      },
    });
    expect(resultWithAction.ok).toBe(false);
  });

  it("refuses a value whose type does not match the field kind", async () => {
    const result = await compileInteractionSurface({
      surfaceId: "s-typed",
      values: { count: "not a number" },
      schema: {
        schemaVersion: 1,
        presentation: "form",
        fields: [{ name: "count", label: "Count", kind: "number", required: true }],
        action: { id: "save", label: "Save", requiresRevision: true },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("puts the revision in the data model so a stale surface cannot submit", async () => {
    const result = await compileInteractionSurface({
      schema,
      values,
      surfaceId: "s-rev",
      revision: 7,
      interactionId: "ix-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const model = surfaceDataModel({
      schema,
      values,
      surfaceId: "s-rev",
      revision: 7,
      interactionId: "ix-1",
    });
    expect(model.values).toEqual(values);
    expect(model.revision).toBe(7);
    expect(model.interactionId).toBe("ix-1");
  });

  it("compiles a third-domain form without email templates", async () => {
    const schema: InteractionSurfaceSchema = {
      schemaVersion: 1,
      presentation: "form",
      fields: [{ name: "note", label: "Note", kind: "text", required: true, maxLength: 80 }],
      action: { id: "save", label: "Save", requiresRevision: true },
    };
    const result = await compileInteractionSurface({
      schema,
      values: { note: "hello" },
      surfaceId: "s-test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const components = componentsOf(result.messages);
    expect(components.some((component) => component.component === "TextField")).toBe(true);
    expect(JSON.stringify(result.messages)).not.toMatch(/email-draft-card|email.compose/);
  });
});
