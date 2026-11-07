import { TimeZoneSchema } from "@matebot/contracts";

/**
 * Result surfaces: read-only data with provenance.
 *
 * The rules here are the ones that keep a result honest. Every value must say
 * where it came from and as of when; an empty result is flagged and never
 * rendered as zeros; an oversized dataset is truncated and says so; and a row
 * may only carry scalar values, so nothing can smuggle structure or a script
 * into the surface.
 *
 * Aggregation is not done here. Callers compute series deterministically and
 * pass rows in; this validates and bounds them so the model cannot invent or
 * reshape data on its way to the card.
 */

/** A result card stays readable and bounded; larger sets are truncated. */
export const RESULT_MAX_ROWS = 200;

export type ResultProvenance = {
  /** Who produced the numbers: a file the user supplied, a connector, a query. */
  source: string;
  /** When the data was measured, not when the card was drawn. */
  asOf: string;
  /** Optional: the period the data covers. */
  window?: { from: string; to: string };
  /** Optional: the unit of any measure, e.g. "CNY" or "count". Never invented. */
  units?: string;
  /** Optional: the zone the window is expressed in. */
  timezone?: string;
  /** Optional: the calendar year the measure belongs to. */
  year?: number;
  /** Optional: when the source itself was last updated. Not the same as asOf. */
  freshness?: string;
};

export type ResultProvenanceError =
  | "missing_source"
  | "invalid_as_of"
  | "invalid_timezone"
  | "invalid_window"
  | "invalid_year"
  | "invalid_freshness";

export type ResultProvenanceValidation =
  | { ok: true; provenance: ResultProvenance }
  | { ok: false; error: ResultProvenanceError };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseable(value: string): boolean {
  // A date-only bound is a valid window edge; Date.parse accepts both.
  return Number.isFinite(Date.parse(value));
}

export function readWindow(
  input: unknown,
): { ok: true; window: { from: string; to: string } } | { ok: false; error: "invalid_window" } {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { from?: unknown; to?: unknown })
      : {};
  const from = text(record.from);
  const to = text(record.to);
  if (!from || !to || !parseable(from) || !parseable(to)) {
    return { ok: false, error: "invalid_window" };
  }
  if (Date.parse(to) < Date.parse(from)) return { ok: false, error: "invalid_window" };
  return { ok: true, window: { from, to } };
}

/**
 * Validate provenance. `source` and `asOf` are required: a result with no
 * traceable origin is exactly what the spec forbids.
 */
export function validateResultProvenance(input: unknown): ResultProvenanceValidation {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const source = text(record.source);
  if (!source) return { ok: false, error: "missing_source" };

  const asOf = text(record.asOf);
  if (!asOf || !parseable(asOf)) return { ok: false, error: "invalid_as_of" };

  const timezone = text(record.timezone);
  if (timezone && !TimeZoneSchema.safeParse(timezone).success) {
    return { ok: false, error: "invalid_timezone" };
  }

  let window: { from: string; to: string } | undefined;
  if (record.window !== undefined) {
    const parsed = readWindow(record.window);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    window = parsed.window;
  }

  const units = text(record.units);

  // A year is a four-digit calendar year; a stray number or a phrase is refused
  // rather than rendered as if it labelled the data.
  let year: number | undefined;
  if (record.year !== undefined && record.year !== null) {
    const parsedYear =
      typeof record.year === "number" ? record.year : Number(text(record.year));
    if (!Number.isInteger(parsedYear) || parsedYear < 1900 || parsedYear > 2999) {
      return { ok: false, error: "invalid_year" };
    }
    year = parsedYear;
  }

  const freshnessText = text(record.freshness);
  if (freshnessText && !parseable(freshnessText)) {
    return { ok: false, error: "invalid_freshness" };
  }

  return {
    ok: true,
    provenance: {
      source,
      asOf,
      ...(window ? { window } : {}),
      ...(units ? { units } : {}),
      ...(timezone ? { timezone } : {}),
      ...(year !== undefined ? { year } : {}),
      ...(freshnessText ? { freshness: freshnessText } : {}),
    },
  };
}

/** Recover provenance from a stored effect/result payload. */
export function provenanceFromUnknown(input: unknown): ResultProvenanceValidation {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return validateResultProvenance(record.provenance);
}

/**
 * What the card says when there is nothing to show. Deliberately a sentence,
 * not a zero: an absent quarter and a quarter that earned nothing are different
 * facts.
 */
export function emptyResultNotice(input: { source: string }): string {
  const source = input.source.trim();
  return source
    ? `No data was found for this period in ${source}.`
    : "No data was found for this period.";
}

export type ResultColumn = { key: string; label: string; align?: "start" | "end" };

export type ResultRow = Record<string, string | number | boolean | null>;

export type ResultSurface = {
  title: string;
  provenance: ResultProvenance;
  columns: ResultColumn[];
  rows: ResultRow[];
  /** True when the caller supplied more rows than the card will show. */
  truncated: boolean;
  /** How many rows the caller actually supplied. */
  totalRows: number;
  /** True when there is genuinely nothing to show, so the host says so. */
  empty: boolean;
  /** The sentence to show for an empty result; absent when there are rows. */
  emptyNotice?: string;
};

export type BuildResultSurfaceInput = {
  title: string;
  provenance: unknown;
  rows: unknown[];
  columns?: ResultColumn[];
};

export type BuildResultSurfaceResult =
  | { ok: true; surface: ResultSurface }
  | { ok: false; error: string };

function scalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Validate and bound a result. Columns default to the first row's keys, so a
 * simple caller needs no schema while a table can still declare its order.
 */
export function buildResultSurface(input: BuildResultSurfaceInput): BuildResultSurfaceResult {
  const provenance = validateResultProvenance(input.provenance);
  if (!provenance.ok) return { ok: false, error: provenance.error };

  const rows = Array.isArray(input.rows) ? input.rows : [];
  const normalized: ResultRow[] = [];
  let columns = input.columns?.length ? [...input.columns] : undefined;

  for (const entry of rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "unsupported_row_value" };
    }
    const record = entry as Record<string, unknown>;
    if (!columns) {
      columns = Object.keys(record).map((key) => ({ key, label: key }));
    }
    const row: ResultRow = {};
    for (const [key, value] of Object.entries(record)) {
      if (!columns.some((column) => column.key === key)) {
        return { ok: false, error: "unknown_column" };
      }
      if (!scalar(value)) return { ok: false, error: "unsupported_row_value" };
      row[key] = value;
    }
    normalized.push(row);
  }

  const totalRows = normalized.length;
  const shown = normalized.slice(0, RESULT_MAX_ROWS);
  const empty = totalRows === 0;

  return {
    ok: true,
    surface: {
      title: input.title,
      provenance: provenance.provenance,
      columns: columns ?? [],
      rows: shown,
      truncated: totalRows > RESULT_MAX_ROWS,
      totalRows,
      empty,
      ...(empty
        ? { emptyNotice: emptyResultNotice({ source: provenance.provenance.source }) }
        : {}),
    },
  };
}

/** The one line under a result card that states where the numbers came from. */
export function provenanceLine(provenance: ResultProvenance): string {
  const parts = [provenance.source];
  if (provenance.year !== undefined) parts.push(String(provenance.year));
  if (provenance.window) parts.push(`${provenance.window.from} – ${provenance.window.to}`);
  if (provenance.units) parts.push(provenance.units);
  parts.push(`as of ${provenance.asOf.slice(0, 10)}`);
  if (provenance.freshness) parts.push(`fresh ${provenance.freshness.slice(0, 10)}`);
  return parts.join(" · ");
}

/**
 * A same-card refresh of a result.
 *
 * Changing the window, or the filter, is a view change on the card the user is
 * already looking at — not a new card. What must not change silently is where the
 * numbers came from: switching source is a new query, and letting a refresh do it
 * would relabel data the user already trusted. Provenance that stays the same is
 * preserved rather than re-derived.
 */
export type RefreshResultInput = {
  revision: number;
  window?: { from: string; to: string };
  rows: unknown[];
  /** A refresh may only repeat the current source; a different one is refused. */
  source?: string;
};

export type RefreshResultOutput =
  | { ok: true; surface: ResultSurface; surfaceTitle: string; revision: number }
  | { ok: false; error: "source_changed" | "invalid_window" | "unsupported_row_value" };

export function refreshResultSurface(
  current: ResultSurface,
  input: RefreshResultInput,
): RefreshResultOutput {
  if (input.source !== undefined && input.source.trim() !== current.provenance.source) {
    return { ok: false, error: "source_changed" };
  }

  let window = current.provenance.window;
  if (input.window !== undefined) {
    const parsed = readWindow(input.window);
    if (!parsed.ok) return { ok: false, error: "invalid_window" };
    window = parsed.window;
  }

  const built = buildResultSurface({
    title: current.title,
    provenance: {
      ...current.provenance,
      ...(window ? { window } : {}),
    },
    columns: current.columns,
    rows: input.rows,
  });
  if (!built.ok) {
    return {
      ok: false,
      error: built.error === "unsupported_row_value" ? "unsupported_row_value" : "invalid_window",
    };
  }
  return {
    ok: true,
    surface: built.surface,
    surfaceTitle: current.title,
    revision: input.revision,
  };
}
