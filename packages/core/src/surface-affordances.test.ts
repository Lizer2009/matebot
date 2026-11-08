import { describe, expect, it } from "vitest";
import { needsRecovery, surfaceAffordances } from "./surface-affordances.js";

/**
 * A card can only offer what it stored.
 *
 * The first compiler drew a title and two lines of text and no controls. Conversations
 * around those cards say "confirm in the card above", a sentence the card can never
 * satisfy. The card must not pretend the button is there — but the reader also has to be
 * told, otherwise the instruction just hangs.
 */

const catalogId = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

function document(components: Array<Record<string, unknown>>): unknown[] {
  return [
    { version: "v0.9", createSurface: { surfaceId: "s", catalogId } },
    { version: "v0.9", updateComponents: { surfaceId: "s", components } },
    { version: "v0.9", updateDataModel: { surfaceId: "s", value: {} } },
  ];
}

describe("what a stored card can do", () => {
  it("reports an early card as having nothing to fill in or press", () => {
    // Exactly what the previous compiler emitted.
    const legacy = document([
      { id: "root", component: "Column", children: ["title", "summary", "fields"] },
      { id: "title", component: "Text", text: { path: "/title" } },
      { id: "summary", component: "Text", text: { path: "/summary" } },
      { id: "fields", component: "Text", text: { path: "/intent" } },
    ]);
    expect(surfaceAffordances(legacy)).toEqual({ editable: false, actionable: false });
    expect(needsRecovery(legacy)).toBe(true);
  });

  it("reports a card this build writes as editable and actionable", () => {
    const current = document([
      { id: "root", component: "Column", children: ["f", "a"] },
      { id: "f", component: "TextField", label: "Name", value: { path: "/values/name" } },
      { id: "a", component: "Button", child: "l" },
    ]);
    expect(surfaceAffordances(current)).toEqual({ editable: true, actionable: true });
    expect(needsRecovery(current)).toBe(false);
  });

  it.each(["TextField", "DateTimeInput", "CheckBox", "ChoicePicker"])(
    "counts %s as something a person can fill in",
    (component) => {
      expect(surfaceAffordances(document([{ id: "f", component }])).editable).toBe(true);
    },
  );

  /**
   * A card with a button but no fields is still confirmable — a result card, for example.
   * Reporting it as needing recovery would nag the reader about a card that works.
   */
  it("does not call a card with only an action recoverable", () => {
    expect(needsRecovery(document([{ id: "a", component: "Button" }]))).toBe(false);
  });

  it.each([
    ["no document", undefined],
    ["an empty document", []],
    ["a document with no components", document([])],
    ["malformed entries", [1, null, "text"]],
  ])("reports %s as having nothing, without throwing", (_label, messages) => {
    expect(() => surfaceAffordances(messages)).not.toThrow();
    expect(surfaceAffordances(messages)).toEqual({ editable: false, actionable: false });
  });
});
