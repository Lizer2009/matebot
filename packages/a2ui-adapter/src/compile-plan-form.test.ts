import { describe, expect, it } from "vitest";
import { compileInteractionPlan } from "./compile.js";

/**
 * A plan's fields must become controls, not a caption.
 *
 * The manual audit reproduced a calendar card that drew its title and then an
 * empty body. The cause was here: a draft plan compiled to three text nodes —
 * title, summary, and the intent string — so no field control was ever emitted for
 * any generic form. A card with a heading over nothing is exactly what the user
 * saw, and it was not a rendering failure downstream.
 */

const plan = {
  intent: "calendar.create",
  title: "Next week's schedule",
  fields: [
    { name: "name", value: "Weekly sync", required: true, status: "resolved" as const },
    {
      name: "start",
      value: "2026-11-09T09:00:00+08:00",
      required: true,
      status: "resolved" as const,
    },
    { name: "timezone", value: "Asia/Shanghai", required: false, status: "resolved" as const },
  ],
  nextStep: "request_approval" as const,
  riskLevel: "medium" as const,
};

async function components() {
  const result = await compileInteractionPlan({ plan, surfaceId: "surface-1" });
  if (!result.ok) throw new Error(result.error);
  const update = result.messages as Array<{
    updateComponents?: { components: Array<Record<string, unknown>> };
  }>;
  const components = update.find((message) => message.updateComponents)?.updateComponents
    ?.components;
  if (!components) throw new Error("no updateComponents message");
  return components;
}

describe("compiling a draft plan into a form", () => {
  it("emits one editable control per field", async () => {
    const list = await components();
    const fields = list.filter((component) =>
      ["TextField", "DateTimeInput", "CheckBox", "ChoicePicker"].includes(
        String(component.component),
      ),
    );
    // One per plan field, not zero.
    expect(fields.map((field) => field.id)).toHaveLength(3);
  });

  it("binds each control to its own value path", async () => {
    const list = await components();
    const paths = list
      .filter((component) => component.component === "TextField")
      .map((component) => (component.value as { path?: string } | undefined)?.path);
    expect(paths).toEqual(["/values/name", "/values/start", "/values/timezone"]);
  });

  it("labels every control exactly once, on the control that can carry one", async () => {
    const list = await components();
    const text = list
      .filter((component) => component.component === "Text")
      .map((component) => component.text);
    const controls = list.filter((component) =>
      ["TextField", "DateTimeInput", "CheckBox", "ChoicePicker"].includes(
        String(component.component),
      ),
    );
    for (const field of ["name", "start", "timezone"]) {
      // The control carries its own label, and no Text repeats it above.
      const control = controls.find((entry) => entry.id === `field_${field}`);
      expect(control?.label).toBe(field);
      expect(text).not.toContain(field);
    }
  });

  it("uses the registered schema's labels and control kinds when given one", async () => {
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "surface-schema",
      schema: {
        schemaVersion: 1,
        presentation: "form",
        fields: [
          { name: "name", label: "Name", kind: "text", required: true },
          { name: "start", label: "Starts", kind: "dateTime", required: true },
          { name: "timezone", label: "Time zone", kind: "text", required: false },
        ],
        action: { id: "create", label: "Create", requiresRevision: true },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const update = result.messages as Array<{
      updateComponents?: { components: Array<Record<string, unknown>> };
    }>;
    const list = update.find((message) => message.updateComponents)!.updateComponents!.components;
    // A date field becomes a date control, not a text box, and carries the
    // schema's label itself — once, on the control, not also as a Text above it.
    const start = list.find((component) => component.id === "field_start");
    expect(start?.component).toBe("DateTimeInput");
    expect(start?.label).toBe("Starts");
    const labels = list
      .filter((component) => component.component === "Text")
      .map((component) => component.text);
    expect(labels).not.toContain("Starts");
    expect(labels).not.toContain("Name");
  });

  it("carries the values the plan already resolved", async () => {
    const result = await compileInteractionPlan({ plan, surfaceId: "surface-1" });
    if (!result.ok) throw new Error(result.error);
    const update = (result.messages as Array<Record<string, unknown>>).find(
      (message) => "updateDataModel" in message,
    ) as { updateDataModel: { value: { values?: Record<string, unknown> } } };
    expect(update.updateDataModel.value.values).toMatchObject({
      name: "Weekly sync",
      start: "2026-11-09T09:00:00+08:00",
    });
  });

  it("offers exactly one action, bound to the revision", async () => {
    const list = await components();
    const buttons = list.filter((component) => component.component === "Button");
    expect(buttons).toHaveLength(1);
    const action = buttons[0]?.action as {
      event: { context: { revision?: { path?: string } } };
    };
    expect(action.event.context.revision?.path).toBe("/revision");
  });

  it("still compiles a plan with no fields without inventing controls", async () => {
    const result = await compileInteractionPlan({
      plan: { ...plan, fields: [] },
      surfaceId: "surface-2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const update = (result.messages as Array<Record<string, unknown>>).find(
      (message) => "updateComponents" in message,
    ) as { updateComponents: { components: Array<Record<string, unknown>> } };
    const fields = update.updateComponents.components.filter((component) =>
      ["TextField", "DateTimeInput", "CheckBox", "ChoicePicker"].includes(
        String(component.component),
      ),
    );
    expect(fields).toEqual([]);
  });
});
