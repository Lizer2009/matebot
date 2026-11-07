import { describe, expect, it } from "vitest";
import { buildResultFromArgs, parseMetrics } from "./run-tools-result.js";

/**
 * Rows the model wrote are shown, but never as if a data source vouched for them.
 *
 * The spec forbids the model inventing a series (§5.6.2). A refusal to accept any
 * rows at all would just push the model to describe numbers in prose instead, so
 * the rows are accepted and labelled: the provenance line says they did not come
 * from a data source, and the sourced path marks its own rows the other way.
 */

const base = {
  title: "Pipeline",
  source: "Model estimate",
  asOf: "2026-11-06T00:00:00Z",
  rows: [{ stage: "Won", amount: 12 }],
};

describe("buildResultFromArgs", () => {
  it("labels model-written rows as not from a data source", () => {
    const built = buildResultFromArgs(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.surface.provenance.attribution).toBe("model");
    expect(built.surface.rows).toEqual([{ stage: "Won", amount: 12 }]);
  });

  it("still requires a source name and a measurement time", () => {
    expect(buildResultFromArgs({ ...base, source: undefined })).toEqual({
      ok: false,
      error: "missing_source",
    });
    expect(buildResultFromArgs({ ...base, asOf: "not a date" })).toEqual({
      ok: false,
      error: "invalid_as_of",
    });
  });

  it("carries year and freshness into the provenance", () => {
    const built = buildResultFromArgs({
      ...base,
      year: 2026,
      freshness: "2026-11-05T12:00:00Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.surface.provenance).toMatchObject({
      year: 2026,
      freshness: "2026-11-05T12:00:00Z",
    });
  });

  it("refuses a year that is not a calendar year", () => {
    expect(buildResultFromArgs({ ...base, year: 26 })).toEqual({
      ok: false,
      error: "invalid_year",
    });
  });
});

describe("parseMetrics", () => {
  it("keeps the supported operations and drops unknown ones", () => {
    expect(
      parseMetrics([
        { key: "total", op: "sum", of: "amount" },
        { key: "n", op: "count" },
        { key: "bad", op: "median", of: "amount" },
        { op: "sum", of: "amount" },
      ]),
    ).toEqual([
      { key: "total", op: "sum", of: "amount" },
      { key: "n", op: "count", of: undefined },
    ]);
  });

  it("treats a non-array as no aggregation at all", () => {
    expect(parseMetrics("sum amount")).toBeUndefined();
    expect(parseMetrics([])).toBeUndefined();
  });
});
