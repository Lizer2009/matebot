import type { ResultRow } from "./interaction-result.js";

/**
 * Reading a CSV the user actually uploaded.
 *
 * A deliberately bounded parser, not a full RFC 4180 implementation: quoted
 * fields, doubled quotes inside them, CRLF or LF, and a header row. What it does
 * *not* do is guess — a column becomes numeric only when every non-empty value in
 * that column is a plain number. `0123` stays a string because an account number
 * is not a quantity, and one stray word keeps the whole column textual instead of
 * mixing types row by row.
 *
 * Everything here is deterministic: the same bytes give the same columns, the
 * same row order and the same types. That is the property the spec needs between
 * "the user's file" and "the number on the card".
 */

/** A larger file is refused rather than truncated: a half-read table lies. */
export const CSV_MAX_BYTES = 4 * 1024 * 1024;
/** A card shows at most this many rows; the caller reports the truncation. */
export const CSV_MAX_ROWS = 1000;
export const CSV_MAX_COLUMNS = 64;

export type ParsedCsv = {
  columns: string[];
  rows: ResultRow[];
  /** How many data rows the file held, before any bound was applied. */
  totalRows: number;
  /** True when rows were dropped because the file exceeded `CSV_MAX_ROWS`. */
  truncated: boolean;
};

export type ParseCsvError =
  | "empty_file"
  | "too_large"
  | "too_many_columns"
  | "unterminated_quote"
  | "no_header"
  | "duplicate_column";

export type ParseCsvResult = { ok: true; csv: ParsedCsv } | { ok: false; error: ParseCsvError };

/** Split a CSV document into raw records of raw fields. */
function splitRecords(text: string): { records: string[][]; unterminated: boolean } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  // A byte order mark would otherwise become part of the first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (index < input.length) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      record.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      index += char === "\r" && input[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (quoted) return { records, unterminated: true };
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return { records, unterminated: false };
}

/**
 * A value that is entirely a number, with an optional sign and decimal part.
 *
 * A leading zero on an integer is refused on purpose: `000123` is an identifier
 * (an account, an order number), and turning it into 123 would change what the
 * cell means while looking like a tidy-up.
 */
export function numericValue(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const integerPart = trimmed.replace(/^-/, "").split(".")[0] ?? "";
  if (integerPart.length > 1 && integerPart.startsWith("0")) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a CSV document into columns and typed rows.
 *
 * The header names the columns; a blank header cell becomes `column_N` so it is
 * still addressable. A duplicate header is refused rather than silently dropping
 * a column, and a short row is padded with an empty value rather than shifted.
 */
export function parseCsv(text: string, options: { maxBytes?: number } = {}): ParseCsvResult {
  const maxBytes = options.maxBytes ?? CSV_MAX_BYTES;
  // Count bytes, not characters: the limit is about what we were sent.
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, error: "too_large" };
  if (text.trim() === "") return { ok: false, error: "empty_file" };

  const split = splitRecords(text);
  if (split.unterminated) return { ok: false, error: "unterminated_quote" };

  // Trailing blank lines are not data.
  const records = split.records.filter(
    (record) => record.length > 1 || (record[0] ?? "").trim() !== "",
  );
  if (records.length === 0) return { ok: false, error: "empty_file" };

  const header = records[0]!.map((name) => name.trim());
  if (header.every((name) => name === "")) return { ok: false, error: "no_header" };
  const columns = header.map((name, index) => (name === "" ? `column_${index + 1}` : name));
  if (new Set(columns).size !== columns.length) return { ok: false, error: "duplicate_column" };
  if (columns.length > CSV_MAX_COLUMNS) return { ok: false, error: "too_many_columns" };

  const body = records.slice(1);
  // Each column's type is decided from every value in it, before any row is built.
  const numeric = columns.map((_, index) => columnIsNumeric(body, index));

  const rows: ResultRow[] = body.map((record) => {
    const row: ResultRow = {};
    for (const [index, column] of columns.entries()) {
      const raw = (record[index] ?? "").trim();
      if (raw === "") {
        row[column] = null;
      } else if (numeric[index]) {
        row[column] = numericValue(raw);
      } else {
        row[column] = raw;
      }
    }
    return row;
  });

  return {
    ok: true,
    csv: {
      columns,
      rows: rows.slice(0, CSV_MAX_ROWS),
      totalRows: rows.length,
      truncated: rows.length > CSV_MAX_ROWS,
    },
  };
}

/** Whether every non-empty value in a column is a plain number. */
function columnIsNumeric(
  records: ReadonlyArray<ReadonlyArray<string>>,
  columnIndex: number,
): boolean {
  let seen = false;
  for (const record of records) {
    const value = (record[columnIndex] ?? "").trim();
    if (value === "") continue;
    if (numericValue(value) === null) return false;
    seen = true;
  }
  return seen;
}
