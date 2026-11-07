import { describe, expect, it } from "vitest";
import { CSV_MAX_ROWS, parseCsv } from "./csv.js";

/**
 * A CSV the user uploaded, read deterministically.
 *
 * The rows here are synthetic on purpose: they are the shape of the parser's
 * input, not anyone's business data. What the tests pin is that the same bytes
 * always give the same columns, order and types, and that the parser refuses
 * input it cannot read rather than inventing a table.
 */

const sales = [
  "quarter,region,amount,orders",
  "Q1,North,1200.50,12",
  "Q1,South,800,8",
  "Q2,North,1500,15",
].join("\n");

describe("parseCsv", () => {
  it("reads a header and typed rows in file order", () => {
    const result = parseCsv(sales);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csv.columns).toEqual(["quarter", "region", "amount", "orders"]);
    expect(result.csv.rows).toEqual([
      { quarter: "Q1", region: "North", amount: 1200.5, orders: 12 },
      { quarter: "Q1", region: "South", amount: 800, orders: 8 },
      { quarter: "Q2", region: "North", amount: 1500, orders: 15 },
    ]);
    expect(result.csv.totalRows).toBe(3);
    expect(result.csv.truncated).toBe(false);
  });

  it("keeps a column textual when any value in it is not a number", () => {
    const result = parseCsv("id,label\n1,a\n2,b\n");
    if (!result.ok) throw new Error(result.error);
    // `id` is numeric throughout, `label` is text.
    expect(result.csv.rows[0]).toEqual({ id: 1, label: "a" });

    const mixed = parseCsv("amount\n1\ntwo\n3\n");
    if (!mixed.ok) throw new Error(mixed.error);
    // One non-number keeps the whole column textual rather than mixing types.
    expect(mixed.csv.rows.map((row) => row.amount)).toEqual(["1", "two", "3"]);
  });

  it("does not turn a leading zero into a number", () => {
    const result = parseCsv("account,balance\n000123,50\n");
    if (!result.ok) throw new Error(result.error);
    // An account number is an identifier, not a quantity.
    expect(result.csv.rows[0]).toEqual({ account: "000123", balance: 50 });
  });

  it("reads quoted fields, embedded commas, doubled quotes and CRLF", () => {
    const result = parseCsv('name,note\r\n"Acme, Inc.","he said ""hi"""\r\n');
    if (!result.ok) throw new Error(result.error);
    expect(result.csv.rows[0]).toEqual({ name: "Acme, Inc.", note: 'he said "hi"' });
  });

  it("pads a short row instead of shifting its values", () => {
    const result = parseCsv("a,b,c\n1,2\n");
    if (!result.ok) throw new Error(result.error);
    expect(result.csv.rows[0]).toEqual({ a: 1, b: 2, c: null });
  });

  it("names a blank header cell so it stays addressable", () => {
    const result = parseCsv("a,,c\n1,2,3\n");
    if (!result.ok) throw new Error(result.error);
    expect(result.csv.columns).toEqual(["a", "column_2", "c"]);
  });

  it("bounds the rows it returns and says so", () => {
    const rows = Array.from({ length: CSV_MAX_ROWS + 5 }, (_, index) => `${index}`);
    const result = parseCsv(`n\n${rows.join("\n")}\n`);
    if (!result.ok) throw new Error(result.error);
    expect(result.csv.rows).toHaveLength(CSV_MAX_ROWS);
    expect(result.csv.totalRows).toBe(CSV_MAX_ROWS + 5);
    expect(result.csv.truncated).toBe(true);
  });

  it("refuses what it cannot read rather than inventing a table", () => {
    expect(parseCsv("")).toEqual({ ok: false, error: "empty_file" });
    expect(parseCsv("   \n\n")).toEqual({ ok: false, error: "empty_file" });
    expect(parseCsv('a\n"unclosed\n')).toEqual({ ok: false, error: "unterminated_quote" });
    expect(parseCsv("a,a\n1,2\n")).toEqual({ ok: false, error: "duplicate_column" });
    expect(parseCsv(",,,\n1,2,3,4\n")).toEqual({ ok: false, error: "no_header" });
    expect(parseCsv("a\n1\n", { maxBytes: 1 })).toEqual({ ok: false, error: "too_large" });
  });

  it("strips a byte order mark instead of gluing it to the first header", () => {
    const result = parseCsv(`\uFEFFquarter,amount\nQ1,10\n`);
    if (!result.ok) throw new Error(result.error);
    expect(result.csv.columns).toEqual(["quarter", "amount"]);
  });
});
