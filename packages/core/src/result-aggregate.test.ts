import { describe, expect, it } from "vitest";
import { aggregateResultRows } from "./result-aggregate.js";

const rows = [
  { quarter: "Q1", amount: 100.5, count: 2 },
  { quarter: "Q1", amount: 99.5, count: 3 },
  { quarter: "Q2", amount: 10, count: 1 },
];

describe("aggregateResultRows", () => {
  it("sums a metric per group in first-seen order", () => {
    const result = aggregateResultRows(
      { rows },
      { groupBy: "quarter", metrics: [{ key: "total", op: "sum", of: "amount" }] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      { quarter: "Q1", total: 200 },
      { quarter: "Q2", total: 10 },
    ]);
    expect(result.columns.map((column) => column.key)).toEqual(["quarter", "total"]);
  });

  it("counts rows without needing a column", () => {
    const result = aggregateResultRows(
      { rows },
      { groupBy: "quarter", metrics: [{ key: "rows", op: "count" }] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.rows)).toEqual([2, 1]);
  });

  it("computes avg, min and max with stable rounding", () => {
    const result = aggregateResultRows(
      { rows },
      {
        metrics: [
          { key: "mean", op: "avg", of: "amount" },
          { key: "lo", op: "min", of: "amount" },
          { key: "hi", op: "max", of: "amount" },
        ],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([{ mean: 70, lo: 10, hi: 100.5 }]);
  });

  it("refuses a metric whose column is not a number", () => {
    const result = aggregateResultRows(
      { rows },
      { metrics: [{ key: "bad", op: "sum", of: "quarter" }] },
    );
    expect(result).toEqual({ ok: false, error: "not_a_number" });
  });

  it("refuses an unknown grouping column", () => {
    const result = aggregateResultRows(
      { rows },
      { groupBy: "nope", metrics: [{ key: "total", op: "sum", of: "amount" }] },
    );
    expect(result).toEqual({ ok: false, error: "unknown_column" });
  });

  it("returns nothing at all when the source returned no rows", () => {
    const result = aggregateResultRows(
      { rows: [] },
      { metrics: [{ key: "total", op: "sum", of: "amount" }] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(0);
  });
});
