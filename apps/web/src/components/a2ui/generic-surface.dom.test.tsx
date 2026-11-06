// @vitest-environment jsdom

import { compileInteractionSurface } from "@matebot/a2ui-adapter";
import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { A2uiRendererModules } from "./load-a2ui";
import { loadA2uiRenderer } from "./load-a2ui";

function radioChecked(radios: NodeListOf<Element>): HTMLInputElement {
  const checked = [...radios].find((radio) => (radio as HTMLInputElement).checked);
  if (!checked) throw new Error("no option was checked from the data model");
  return checked as HTMLInputElement;
}

/**
 * Integration, not snapshots: these mount the real `@a2ui/react` renderer on a
 * tree the real compiler produced and assert on the resulting DOM. The old
 * compiler emitted Column + three Text, which passed every pure test and gave
 * the user nothing to type into; only a mounted surface catches that.
 */

let host: HTMLDivElement;
let root: Root;
let mods: A2uiRendererModules;

const emailSchema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true },
    { name: "subject", label: "Subject", kind: "text", required: true },
    { name: "body", label: "Message", kind: "longText", required: false },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

async function mount(schema: InteractionSurfaceSchema, values: Record<string, unknown>) {
  const compiled = await compileInteractionSurface({ schema, values, surfaceId: "s-1" });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error);
  const processor = new mods.MessageProcessor([mods.basicCatalog]);
  processor.processMessages(compiled.messages as never[]);
  const surface = processor.model.surfacesMap.get("s-1");
  expect(surface).toBeTruthy();
  await act(async () => {
    root.render(createElement(mods.A2uiSurface, { surface: surface as never }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  return compiled;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mods = await loadA2uiRenderer();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("generic compiled surface (real renderer)", () => {
  // Two shortText fields become <input>, the longText one becomes <textarea>.
  it("renders a real control per declared field", async () => {
    await mount(emailSchema, { to: "a@example.com", subject: "Hi", body: "" });
    expect(host.querySelectorAll("input[type='text']")).toHaveLength(2);
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
    expect(host.querySelectorAll("a2ui-basic-textfield")).toHaveLength(3);
  });

  it("shows the server value in the longText control", async () => {
    await mount(emailSchema, { to: "a@example.com", subject: "Hi", body: "hello there" });
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello there");
  });

  it("renders the labels the schema declared", async () => {
    await mount(emailSchema, { to: "a@example.com", subject: "Hi", body: "" });
    const text = host.textContent ?? "";
    for (const label of ["To", "Subject", "Message"]) expect(text).toContain(label);
  });

  // The single primary action is a real button, not a Text that looks like one.
  it("renders exactly one button for the single declared action", async () => {
    await mount(emailSchema, { to: "a@example.com", subject: "Hi", body: "" });
    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("Send");
  });

  it("renders a choice field as a real select", async () => {
    await mount(
      {
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
      { visibility: "team" },
    );
    // ChoicePicker renders a radio group, not a <select>.
    const radios = host.querySelectorAll("input[type='radio']");
    expect(radios).toHaveLength(2);
    expect([...radios].map((radio) => (radio as HTMLInputElement).value)).toEqual([
      "private",
      "team",
    ]);
    expect(radioChecked(radios).value).toBe("team");
  });

  it("renders a boolean field as a checkbox", async () => {
    await mount(
      {
        schemaVersion: 1,
        presentation: "form",
        fields: [{ name: "allDay", label: "All day", kind: "boolean", required: false }],
        action: { id: "create", label: "Create", requiresRevision: true },
      },
      { allDay: true },
    );
    const checkbox = host.querySelector("input[type='checkbox']");
    expect(checkbox).toBeTruthy();
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  // A result surface must not sprout inputs or a submit button.
  it("renders a result surface with data and no controls", async () => {
    const compiled = await compileInteractionSurface({
      surfaceId: "s-1",
      values: {},
      schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
      result: { title: "Revenue", rows: ["Q1 1.2M", { Q2: "1.6M" }] },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const processor = new mods.MessageProcessor([mods.basicCatalog]);
    processor.processMessages(compiled.messages as never[]);
    const surface = processor.model.surfacesMap.get("s-1");
    await act(async () => {
      root.render(createElement(mods.A2uiSurface, { surface: surface as never }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Revenue");
    expect(text).toContain("Q1 1.2M");
    expect(text).toContain("Q2: 1.6M");
    expect(host.querySelectorAll("input").length).toBe(0);
    expect(host.querySelectorAll("button").length).toBe(0);
  });
});
