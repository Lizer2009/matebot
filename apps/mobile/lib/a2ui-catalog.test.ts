import { describe, expect, it } from "vitest";
import {
  emailFieldsFromSurfaceMessages,
  isEmailComposeIntent,
  parseNativeCatalog,
} from "./a2ui-catalog";

describe("native A2UI catalog", () => {
  it("reads email slots from the data model", () => {
    expect(
      emailFieldsFromSurfaceMessages([
        {
          updateDataModel: {
            value: {
              fields: [
                { name: "to", value: "a@b.c" },
                { name: "subject", value: "Hi" },
                { name: "body", value: "There" },
              ],
            },
          },
        },
      ]),
    ).toEqual({ to: "a@b.c", subject: "Hi", body: "There" });
    expect(emailFieldsFromSurfaceMessages(undefined)).toEqual({ to: "", subject: "", body: "" });
  });

  it("recognizes the email compose intents", () => {
    expect(isEmailComposeIntent("email.compose")).toBe(true);
    expect(isEmailComposeIntent("email.send")).toBe(true);
    expect(isEmailComposeIntent("other")).toBe(false);
  });

  it("parses Text, Column, TextField, Button, and Sheet", () => {
    const result = parseNativeCatalog([
      { updateDataModel: { value: { title: "Hello", note: "Body" } } },
      {
        updateComponents: {
          components: [
            {
              id: "col",
              component: "Column",
              children: ["title", "field", "missing", "go", "sheet"],
            },
            { id: "title", component: "Text", text: { path: "/title" } },
            { id: "field", component: "TextField", label: "Note", value: { path: "/note" } },
            { id: "missing", component: "Text", text: { path: "/count" } },
            { id: "go", component: "Button", text: "Go" },
            { id: "sheet", component: "Sheet", label: "More", children: ["title"] },
          ],
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      nodes: [
        {
          type: "Column",
          children: [
            { type: "Text", text: "Hello" },
            { type: "TextField", id: "field", label: "Note", value: "Body" },
            { type: "Text", text: "" },
            { type: "Button", id: "go", label: "Go" },
            { type: "Sheet", title: "More", children: [{ type: "Text", text: "Hello" }] },
          ],
        },
      ],
    });
  });

  it("refuses a component outside the native catalog", () => {
    expect(
      parseNativeCatalog([
        { updateComponents: { components: [{ id: "root", component: "EvilWidget" }] } },
      ]),
    ).toEqual({ ok: false, component: "EvilWidget" });
  });
});
