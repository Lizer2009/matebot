import type { ResultColumn, ResultRow } from "./interaction-result.js";

/**
 * Deterministic aggregation over rows a registered source returned.
 *
 * The spec forbids the model inventing a series (§5.6.2). The reason a model
 * ends up inventing one is that it is the only thing left holding a pen: it has
 * the rows in its context and the card needs a total. So the total is computed
 * here instead, from rows the server read itself, in a fixed order with fixed
 * rounding. The model may name the metric and the grouping; it never supplies
 * the numbers.
 */

export type AggregateOp = "sum" | "count" | "avg" | "min" | "max";

export type AggregateMetric = {
  /** Output column key. */
  key: string;
  op: AggregateOp;
  /** Input column for every op except `count`, which counts rows. */
  of?: string;
};

export type ResultAggregation = {
  /** Group rows by this column; absent means one row over everything. */
  groupBy?: string;
  metrics: AggregateMetric[];
};

export type AggregateRowsResult =
  | { ok: true; rows: ResultRow[]; columns: ResultColumn[] }
  | { ok: false; error: "unknown_column" | "not_a_number" | "empty_metrics" };

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Two decimals is enough for a money or ratio column and keeps output stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function aggregateResultRows(
  input: { rows: readonly ResultRow[]; columns?: readonly ResultColumn[] },
  aggregation: ResultAggregation,
): AggregateRowsResult {
  if (!aggregation.metrics.length) return { ok: false, error: "empty_metrics" };
  const rows = [...input.rows];

  // No rows means nothing to verify a column against, and an empty window is a
  // real answer. Say "no data" rather than "unknown column".
  if (rows.length === 0) {
    return {
      ok: true,
      rows: [],
      columns: [
        ...(aggregation.groupBy ? [{ key: aggregation.groupBy, label: aggregation.groupBy }] : []),
        ...aggregation.metrics.map((metric) => ({ key: metric.key, label: metric.key })),
      ],
    };
  }

  const known = new Set<string>(input.columns?.map((column) => column.key) ?? []);
  for (const row of rows) for (const key of Object.keys(row)) known.add(key);

  const groupBy = aggregation.groupBy;
  if (groupBy && !known.has(groupBy)) return { ok: false, error: "unknown_column" };
  for (const metric of aggregation.metrics) {
    if (metric.op === "count") continue;
    if (!metric.of || !known.has(metric.of)) return { ok: false, error: "unknown_column" };
  }

  // Preserve the order groups first appear in, so the table does not reshuffle
  // between a refresh and the card the user already read.
  const buckets = new Map<string, { label: ResultRow[keyof ResultRow]; rows: ResultRow[] }>();
  for (const row of rows) {
    const label = groupBy ? (row[groupBy] ?? null) : null;
    const key = groupBy ? String(label) : "";
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(row);
    else buckets.set(key, { label, rows: [row] });
  }
  if (buckets.size === 0 && !groupBy) buckets.set("", { label: null, rows: [] });

  const out: ResultRow[] = [];
  for (const bucket of buckets.values()) {
    const row: ResultRow = {};
    if (groupBy) row[groupBy] = bucket.label;
    for (const metric of aggregation.metrics) {
      if (metric.op === "count") {
        row[metric.key] = bucket.rows.length;
        continue;
      }
      const values: number[] = [];
      for (const entry of bucket.rows) {
        const value = numeric(entry[metric.of!]);
        // A number is either there or it is not; quietly treating a missing
        // value as zero would invent data, so the whole metric is refused.
        if (value === null) return { ok: false, error: "not_a_number" };
        values.push(value);
      }
      if (values.length === 0) {
        row[metric.key] = null;
        continue;
      }
      switch (metric.op) {
        case "sum":
          row[metric.key] = round(values.reduce((total, value) => total + value, 0));
          break;
        case "avg":
          row[metric.key] = round(
            values.reduce((total, value) => total + value, 0) / values.length,
          );
          break;
        case "min":
          row[metric.key] = round(Math.min(...values));
          break;
        case "max":
          row[metric.key] = round(Math.max(...values));
          break;
      }
    }
    out.push(row);
  }

  const columns: ResultColumn[] = [
    ...(groupBy ? [{ key: groupBy, label: groupBy }] : []),
    ...aggregation.metrics.map((metric) => ({ key: metric.key, label: metric.key })),
  ];
  return { ok: true, rows: out, columns };
}
