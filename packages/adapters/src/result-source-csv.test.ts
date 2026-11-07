import { describe, expect, it } from "vitest";
import { csvResultReader } from "./result-source-csv.js";
import { resolveSourceBackedRows } from "./run-tools-result-source.js";

/**
 * A result card built from a file the user actually uploaded.
 *
 * The file bytes here are synthetic — three rows of made-up quarterly figures —
 * because the point is the path, not anyone's business data. What the tests pin:
 * the rows come from bytes the store returned, the arithmetic is done by the
 * server, and a file outside this user's ownership is never read.
 */

const csvBytes = new TextEncoder().encode(
  [
    "quarter,region,amount,orders",
    "Q1,North,1200.50,12",
    "Q1,South,800,8",
    "Q2,North,1500,15",
  ].join("\n"),
);

function store(files: Record<string, { name: string; mimeType: string; bytes: Uint8Array }>) {
  const reads: string[] = [];
  return {
    reads,
    artifacts: {
      find: async (id: string) => {
        const file = files[id];
        return file
          ? { id, name: file.name, mimeType: file.mimeType, storageKey: `key-${id}` }
          : null;
      },
      read: async (storageKey: string) => {
        reads.push(storageKey);
        const id = storageKey.replace(/^key-/, "");
        const file = files[id];
        if (!file) throw new Error("missing bytes");
        return file.bytes;
      },
    },
  };
}

describe("csvResultReader", () => {
  it("reads the file the user attached and reports its name as the source", async () => {
    const { artifacts, reads } = store({
      "art-1": { name: "q3.csv", mimeType: "text/csv", bytes: csvBytes },
    });
    const reader = csvResultReader({ artifacts, attachedArtifactIds: ["art-1"] });
    expect(reader).toBeDefined();
    const result = await reader!({
      window: { from: "2026-01-01", to: "2026-12-31" },
      connectionId: null,
      timezone: "UTC",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      { quarter: "Q1", region: "North", amount: 1200.5, orders: 12 },
      { quarter: "Q1", region: "South", amount: 800, orders: 8 },
      { quarter: "Q2", region: "North", amount: 1500, orders: 15 },
    ]);
    // The card says which file, not a generic label.
    expect(result.sourceLabel).toBe("Upload: q3.csv");
    expect(reads).toEqual(["key-art-1"]);
  });

  it("is not offered at all when this turn has no attachment", () => {
    const { artifacts } = store({});
    expect(csvResultReader({ artifacts, attachedArtifactIds: [] })).toBeUndefined();
  });

  it("reads the newest attachment first", async () => {
    const older = new TextEncoder().encode("a\n1\n");
    const newer = new TextEncoder().encode("b\n2\n");
    const { artifacts } = store({
      "art-old": { name: "old.csv", mimeType: "text/csv", bytes: older },
      "art-new": { name: "new.csv", mimeType: "text/csv", bytes: newer },
    });
    const reader = csvResultReader({
      artifacts,
      attachedArtifactIds: ["art-old", "art-new"],
    });
    const result = await reader!({
      window: { from: "2026-01-01", to: "2026-12-31" },
      connectionId: null,
      timezone: "UTC",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.sourceLabel).toBe("Upload: new.csv");
  });

  it("refuses an artifact id that is not this user's instead of reading another file", async () => {
    const { artifacts, reads } = store({
      "art-mine": { name: "mine.csv", mimeType: "text/csv", bytes: csvBytes },
    });
    const reader = csvResultReader(
      { artifacts, attachedArtifactIds: ["art-mine"] },
      { artifactId: "art-someone-else" },
    );
    const result = await reader!({
      window: { from: "2026-01-01", to: "2026-12-31" },
      connectionId: null,
      timezone: "UTC",
    });
    expect(result).toEqual({ ok: false, error: "not_a_csv", outcome: "failed" });
    // It did not fall back to a different file.
    expect(reads).toEqual([]);
  });

  it("refuses a file that is not a spreadsheet", async () => {
    const { artifacts } = store({
      "art-pdf": { name: "contract.pdf", mimeType: "application/pdf", bytes: csvBytes },
    });
    const reader = csvResultReader({ artifacts, attachedArtifactIds: ["art-pdf"] });
    const result = await reader!({
      window: { from: "2026-01-01", to: "2026-12-31" },
      connectionId: null,
      timezone: "UTC",
    });
    expect(result).toMatchObject({ ok: false, error: "no_uploaded_file" });
  });

  it("reports a file it cannot parse rather than showing a partial table", async () => {
    const { artifacts } = store({
      "art-bad": {
        name: "broken.csv",
        mimeType: "text/csv",
        bytes: new TextEncoder().encode('a\n"unclosed\n'),
      },
    });
    const reader = csvResultReader({ artifacts, attachedArtifactIds: ["art-bad"] });
    const result = await reader!({
      window: { from: "2026-01-01", to: "2026-12-31" },
      connectionId: null,
      timezone: "UTC",
    });
    expect(result).toEqual({ ok: false, error: "unterminated_quote", outcome: "failed" });
  });

  it("filters by the requested window when the file has date-like values", async () => {
    const bytes = new TextEncoder().encode(
      ["date,amount", "2026-01-05,10", "2026-07-05,20", "2026-11-05,30"].join("\n"),
    );
    const { artifacts } = store({
      "art-d": { name: "ledger.csv", mimeType: "text/csv", bytes },
    });
    const reader = csvResultReader({ artifacts, attachedArtifactIds: ["art-d"] });
    const result = await reader!({
      window: { from: "2026-07-01", to: "2026-09-30" },
      connectionId: null,
      timezone: "UTC",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.rows).toEqual([{ date: "2026-07-05", amount: 20 }]);
  });
});

describe("a result card from an uploaded file", () => {
  it("computes the total from the rows it read", async () => {
    const { artifacts } = store({
      "art-1": { name: "q3.csv", mimeType: "text/csv", bytes: csvBytes },
    });
    const resolved = await resolveSourceBackedRows(
      {
        sourceId: "csv-upload",
        from: "2026-01-01",
        to: "2026-12-31",
        groupBy: "quarter",
        metrics: [{ key: "total", op: "sum", of: "amount" }],
      },
      {
        connectionFor: async () => null,
        csvRead: csvResultReader({ artifacts, attachedArtifactIds: ["art-1"] }),
      },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // 1200.50 + 800 = 2000.50, computed here rather than supplied by a model.
    expect(resolved.rows).toEqual([
      { quarter: "Q1", total: 2000.5 },
      { quarter: "Q2", total: 1500 },
    ]);
    expect(resolved.provenance).toMatchObject({
      source: "Upload: q3.csv",
      attribution: "source",
    });
  });

  it("refuses when no file is in scope instead of showing an empty table", async () => {
    const resolved = await resolveSourceBackedRows(
      { sourceId: "csv-upload", from: "2026-01-01", to: "2026-12-31" },
      { connectionFor: async () => null },
    );
    expect(resolved).toMatchObject({ ok: false, error: "csv_read_not_wired" });
  });
});
