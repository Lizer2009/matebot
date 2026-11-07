import { describe, expect, it } from "vitest";
import {
  buildResultSurface,
  emptyResultNotice,
  provenanceFromUnknown,
  provenanceLine,
  RESULT_MAX_ROWS,
  readWindow,
  validateResultProvenance,
} from "./interaction-result.js";

/**
 * Result surfaces carry data plus provenance. The parts that matter are the
 * honest ones: an empty result is not a zero, missing provenance is not "unknown
 * but fine", and a huge dataset is truncated visibly rather than silently
 * dropped or shipped whole.
 */

const provenance = {
  source: "user-provided CSV",
  asOf: "2026-11-06T00:00:00.000Z",
  window: { from: "2026-01-01", to: "2026-12-31" },
  units: "CNY",
  timezone: "Asia/Shanghai",
};

describe("validateResultProvenance", () => {
  it("accepts a complete provenance record", () => {
    expect(validateResultProvenance(provenance)).toMatchObject({ ok: true });
  });

  // The core honesty rule: a result must say where its numbers came from.
  it("refuses provenance with no source", () => {
    expect(validateResultProvenance({ ...provenance, source: "  " })).toMatchObject({
      ok: false,
      error: "missing_source",
    });
  });

  it("refuses an unparseable as-of timestamp", () => {
    expect(validateResultProvenance({ ...provenance, asOf: "yesterday" })).toMatchObject({
      ok: false,
      error: "invalid_as_of",
    });
  });

  it("refuses an unknown timezone", () => {
    expect(validateResultProvenance({ ...provenance, timezone: "Mars/Olympus" })).toMatchObject({
      ok: false,
      error: "invalid_timezone",
    });
  });

  it("refuses a window whose end precedes its start", () => {
    expect(
      validateResultProvenance({
        ...provenance,
        window: { from: "2026-12-31", to: "2026-01-01" },
      }),
    ).toMatchObject({ ok: false, error: "invalid_window" });
  });

  it("keeps optional units absent rather than inventing a currency", () => {
    const result = validateResultProvenance({ ...provenance, units: undefined });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.provenance.units).toBeUndefined();
  });
});

describe("emptyResultNotice", () => {
  // An empty result and a real zero must never look the same.
  it("says there is no data rather than showing zero", () => {
    const notice = emptyResultNotice({ source: "user-provided CSV" });
    expect(notice).toMatch(/no data|nothing/i);
    expect(notice).not.toBe("0");
  });

  it("names the source so the user can tell where the emptiness came from", () => {
    expect(emptyResultNotice({ source: "user-provided CSV" })).toContain("user-provided CSV");
  });
});

describe("buildResultSurface", () => {
  it("turns typed rows into a bounded result with provenance", () => {
    const result = buildResultSurface({
      title: "Annual sales",
      provenance,
      columns: [
        { key: "quarter", label: "Quarter" },
        { key: "total", label: "Total", align: "end" },
      ],
      rows: [
        { quarter: "Q1", total: "1.2M" },
        { quarter: "Q2", total: "1.6M" },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.surface.title).toBe("Annual sales");
    expect(result.surface.rows).toHaveLength(2);
    expect(result.surface.provenance.source).toBe("user-provided CSV");
    expect(result.surface.truncated).toBe(false);
  });

  it("keeps an empty result empty and flagged, not padded with zeros", () => {
    const result = buildResultSurface({ title: "Sales", provenance, rows: [] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.surface.rows).toHaveLength(0);
    expect(result.surface.empty).toBe(true);
  });

  it("truncates an oversized dataset and says it did", () => {
    const rows = Array.from({ length: RESULT_MAX_ROWS + 25 }, (_, index) => ({
      n: String(index),
    }));
    const result = buildResultSurface({ title: "Big", provenance, rows });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.surface.rows).toHaveLength(RESULT_MAX_ROWS);
    expect(result.surface.truncated).toBe(true);
    expect(result.surface.totalRows).toBe(RESULT_MAX_ROWS + 25);
  });

  it("refuses a row that carries a non-scalar value", () => {
    const result = buildResultSurface({
      title: "Bad",
      provenance,
      // A nested object or function could smuggle structure into the surface.
      rows: [{ nested: { a: 1 } as never }],
    });
    expect(result).toMatchObject({ ok: false, error: "unsupported_row_value" });
  });

  it("refuses rows that disagree with the declared columns", () => {
    const result = buildResultSurface({
      title: "Bad",
      provenance,
      columns: [{ key: "a", label: "A" }],
      rows: [{ b: "unexpected" }],
    });
    expect(result).toMatchObject({ ok: false, error: "unknown_column" });
  });

  it("refuses a surface with no provenance at all", () => {
    expect(
      buildResultSurface({ title: "No source", provenance: { source: "" } as never, rows: [] }),
    ).toMatchObject({ ok: false });
  });
});

describe("readWindow", () => {
  it("accepts a window with a start and an end", () => {
    expect(readWindow({ from: "2026-01-01", to: "2026-12-31" })).toMatchObject({ ok: true });
  });

  it("refuses a window missing an end", () => {
    expect(readWindow({ from: "2026-01-01" })).toMatchObject({
      ok: false,
      error: "invalid_window",
    });
  });

  it("refuses an unparseable bound", () => {
    expect(readWindow({ from: "soon", to: "later" })).toMatchObject({
      ok: false,
      error: "invalid_window",
    });
  });
});

describe("provenanceFromUnknown", () => {
  it("recovers provenance from a stored result payload", () => {
    expect(provenanceFromUnknown({ provenance })).toMatchObject({ ok: true });
  });

  it("reports absence rather than returning a half-filled record", () => {
    expect(provenanceFromUnknown({})).toMatchObject({ ok: false, error: "missing_source" });
    expect(provenanceFromUnknown(null)).toMatchObject({ ok: false });
  });
});

describe("spec §5.6.1 provenance fields", () => {
  it("carries the year the measure belongs to", () => {
    const result = validateResultProvenance({ ...provenance, year: 2026 });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.provenance.year).toBe(2026);
  });

  it("rejects a year that is not a plausible four-digit year", () => {
    expect(validateResultProvenance({ ...provenance, year: 26 })).toMatchObject({
      ok: false,
      error: "invalid_year",
    });
    expect(validateResultProvenance({ ...provenance, year: "last year" })).toMatchObject({
      ok: false,
      error: "invalid_year",
    });
  });

  // Freshness is when the source was last updated, which is not the same as asOf
  // (when the measure was taken) and must be parseable rather than free text.
  it("carries the freshness timestamp of the source", () => {
    const result = validateResultProvenance({
      ...provenance,
      freshness: "2026-11-05T22:00:00.000Z",
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.provenance.freshness).toBe("2026-11-05T22:00:00.000Z");
  });

  it("rejects an unparseable freshness instead of showing it", () => {
    expect(validateResultProvenance({ ...provenance, freshness: "recently" })).toMatchObject({
      ok: false,
      error: "invalid_freshness",
    });
  });

  it("states both in the provenance line", () => {
    const line = provenanceLine({
      source: "user-provided CSV",
      asOf: "2026-11-06T00:00:00.000Z",
      year: 2026,
      freshness: "2026-11-05T22:00:00.000Z",
    });
    expect(line).toContain("2026");
    expect(line).toMatch(/fresh|更新/i);
  });
});

describe("a window the assistant chose", () => {
  it("is marked so the card never presents it as the user's choice", () => {
    const built = buildResultSurface({
      title: "Flights",
      provenance: {
        source: "somewhere",
        asOf: "2026-11-07T00:00:00Z",
        window: { from: "2026-11-09", to: "2026-11-16" },
        defaultedWindow: true,
      },
      rows: [{ a: 1 }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.surface.provenance.defaultedWindow).toBe(true);
    expect(provenanceLine(built.surface.provenance)).toContain("dates assumed");
  });

  it("stays unmarked when the period came from the user", () => {
    const built = buildResultSurface({
      title: "Flights",
      provenance: {
        source: "somewhere",
        asOf: "2026-11-07T00:00:00Z",
        window: { from: "2026-11-09", to: "2026-11-16" },
      },
      rows: [{ a: 1 }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.surface.provenance.defaultedWindow).toBeUndefined();
    expect(provenanceLine(built.surface.provenance)).not.toContain("dates assumed");
  });
});
