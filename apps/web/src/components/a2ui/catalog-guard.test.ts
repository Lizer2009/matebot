import { describe, expect, it } from "vitest";
import { guardA2uiCatalogMessages } from "./catalog-guard";
import { minimalV09SurfaceMessages, unknownComponentSurfaceMessages } from "./fixtures";

describe("guardA2uiCatalogMessages", () => {
  it("accepts the minimal basic-catalog fixture", () => {
    expect(guardA2uiCatalogMessages(minimalV09SurfaceMessages())).toEqual({ ok: true });
  });

  it("refuses unknown component names", () => {
    const result = guardA2uiCatalogMessages(unknownComponentSurfaceMessages());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unknownComponents).toContain("EvilWidget");
    expect(result.reason).toMatch(/EvilWidget/);
  });

  it("refuses non-string component fields", () => {
    const result = guardA2uiCatalogMessages([
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "x",
          components: [{ id: "root", component: { type: "div", props: {} } }],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unknownComponents).toContain("[non-string]");
  });

  it("refuses a non-array message list", () => {
    expect(guardA2uiCatalogMessages({} as unknown as unknown[]).ok).toBe(false);
  });
});
