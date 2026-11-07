// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { compileInteractionSurface } from "@matebot/a2ui-adapter";
import type { ResultSurface } from "@matebot/contracts";
import { parseNativeCatalog } from "./a2ui-catalog";

/**
 * A result table compiles to header/cell `Row`s. The phone must render those,
 * because the spec requires a readable table fallback with provenance on mobile,
 * not a refused card.
 */

const surface: ResultSurface = {
  title: "Annual sales",
  provenance: {
    source: "user-provided CSV",
    asOf: "2026-11-06T00:00:00.000Z",
    window: { from: "2026-01-01", to: "2026-12-31" },
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
};

async function compiled(): Promise<unknown[]> {
  const result = await compileInteractionSurface({
    schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
    values: {},
    surfaceId: "s-1",
    result: surface,
  });
  if (!result.ok) throw new Error(result.error);
  return result.messages;
}

describe("mobile result rendering", () => {
  it("accepts the compiled table instead of refusing it", async () => {
    const parsed = parseNativeCatalog(await compiled());
    expect(parsed).toMatchObject({ ok: true });
  });

  it("renders every header label and cell value", async () => {
    const parsed = parseNativeCatalog(await compiled());
    if (!parsed.ok) throw new Error(`refused: ${parsed.component}`);
    const text = JSON.stringify(parsed.nodes);
    for (const value of ["Quarter", "Total", "Q1", "1.2M", "Q2", "1.6M"]) {
      expect(text).toContain(value);
    }
  });

  // Provenance is the honesty requirement, so it must survive on the phone.
  it("keeps the provenance line with its source and units", async () => {
    const parsed = parseNativeCatalog(await compiled());
    if (!parsed.ok) throw new Error(`refused: ${parsed.component}`);
    const text = JSON.stringify(parsed.nodes);
    expect(text).toContain("user-provided CSV");
    expect(text).toContain("CNY");
  });

  it("renders an empty result as a notice, not a table", async () => {
    const result = await compileInteractionSurface({
      schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
      values: {},
      surfaceId: "s-1",
      result: {
        ...surface,
        columns: [],
        rows: [],
        totalRows: 0,
        empty: true,
        emptyNotice: "No data was found for this period in user-provided CSV.",
      },
    });
    if (!result.ok) throw new Error(result.error);
    const parsed = parseNativeCatalog(result.messages);
    if (!parsed.ok) throw new Error(`refused: ${parsed.component}`);
    expect(JSON.stringify(parsed.nodes)).toContain("No data was found");
  });
});
