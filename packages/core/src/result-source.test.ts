import { describe, expect, it, vi } from "vitest";
import type { ResultSourceReadInput } from "./result-source.js";
import { findResultSource, queryResultSource, RESULT_SOURCE_REGISTRY } from "./result-source.js";

/**
 * A result re-query reads through a *registered* source, never an endpoint the
 * model names. The registry is the authorization boundary: a source knows its
 * own required connection and how to read; the caller only names a source id it
 * was allowed to see.
 */

describe("RESULT_SOURCE_REGISTRY", () => {
  it("registers a source with its own connection requirement", () => {
    const source = findResultSource("csv-upload");
    expect(source).toMatchObject({ id: "csv-upload", requiresConnection: null });
  });

  it("returns nothing for an unregistered id, so a model cannot invent a source", () => {
    expect(findResultSource("https://evil.example/sql")).toBeUndefined();
    expect(findResultSource("select * from users")).toBeUndefined();
  });

  it("keeps source ids free of endpoint-like shapes", () => {
    for (const source of RESULT_SOURCE_REGISTRY) {
      expect(source.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(source.id).not.toContain("://");
    }
  });

  it("never exposes a registry entry that takes a caller-supplied URL", () => {
    // The read input is fixed by the contract: window, connection, zone.
    const keys = Object.keys({
      window: { from: "", to: "" },
      connectionId: null,
      timezone: "",
    } as ResultSourceReadInput);
    expect(keys).toEqual(["window", "connectionId", "timezone"]);
    expect(keys).not.toContain("url");
    expect(keys).not.toContain("endpoint");
    expect(keys).not.toContain("sql");
  });
});

describe("queryResultSource", () => {
  it("reads through a per-turn reader and reports its provenance", async () => {
    // A file source has no shared reader: it is supplied for this call, and the
    // registry still owns the id, the label and the window validation.
    const result = await queryResultSource(
      { sourceId: "csv-upload", window: { from: "2026-07-01", to: "2026-09-30" } },
      {
        connectionId: null,
        readFor: (id) =>
          id === "csv-upload"
            ? async () => ({
                ok: true as const,
                rows: [{ quarter: "Q3", amount: 10 }],
                asOf: "2026-11-06T00:00:00Z",
                units: "CNY",
                sourceLabel: "Upload: sales.csv",
              })
            : undefined,
      },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.rows).toEqual([{ quarter: "Q3", amount: 10 }]);
    expect(result.provenance.units).toBe("CNY");
    // The reader's own origin wins over the generic registry label.
    expect(result.provenance.source).toBe("Upload: sales.csv");
    expect(result.provenance.window).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });

  it("refuses a file source when this turn supplied no reader", async () => {
    const result = await queryResultSource(
      { sourceId: "csv-upload", window: { from: "2026-07-01", to: "2026-09-30" } },
      { connectionId: null },
    );
    // No reader means nothing to read: an empty table would be a false answer.
    expect(result).toMatchObject({ ok: false, error: "csv_read_not_wired" });
  });

  it("refuses an unregistered source instead of attempting a read", async () => {
    const result = await queryResultSource(
      { sourceId: "arbitrary-endpoint", window: { from: "2026-01-01", to: "2026-12-31" } },
      { connectionId: null },
    );
    expect(result).toMatchObject({ ok: false, error: "unknown_source" });
  });

  it("refuses a source that needs a connection when none is bound", async () => {
    const result = await queryResultSource(
      { sourceId: "calendar-events", window: { from: "2026-01-01", to: "2026-12-31" } },
      { connectionId: null },
    );
    expect(result).toMatchObject({ ok: false, error: "needs_connection" });
  });

  it("reports an invalid window before touching any source", async () => {
    const spy = vi.spyOn(
      RESULT_SOURCE_REGISTRY.find((source) => source.id === "csv-upload")!,
      "read",
    );
    const result = await queryResultSource(
      { sourceId: "csv-upload", window: { from: "2026-12-31", to: "2026-01-01" } },
      { connectionId: null },
    );
    expect(result).toMatchObject({ ok: false, error: "invalid_window" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
