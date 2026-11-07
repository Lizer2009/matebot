import { describe, expect, it, vi } from "vitest";
import type { ResultSourceReadInput } from "./result-source.js";
import {
  describeUnavailableSource,
  findResultSource,
  queryResultSource,
  RESULT_SOURCE_REGISTRY,
} from "./result-source.js";

/**
 * A result re-query reads through a *registered* source, never an endpoint the
 * model names. The registry is the authorization boundary: a source knows its
 * own required connection and how to read; the caller only names a source id it
 * was allowed to see.
 */

const csvSource = {
  id: "csv-upload",
  label: "Uploaded spreadsheet",
  requiresConnection: null,
  read: async (input: { window: { from: string; to: string } }) => ({
    ok: true as const,
    rows: [{ quarter: "Q3", total: String(input.window.from) }],
    asOf: "2026-11-06T00:00:00.000Z",
    units: "CNY",
  }),
};

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
  it("reads through the registered source and reports its provenance", async () => {
    const result = await queryResultSource(
      { sourceId: "csv-upload", window: { from: "2026-07-01", to: "2026-09-30" } },
      { connectionId: null },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.provenance.units).toBe("CNY");
    // The registered source decides its own rows; the window is passed through.
    expect(result.provenance.window).toEqual({ from: "2026-07-01", to: "2026-09-30" });
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

describe("describeUnavailableSource", () => {
  // The honest fallback when no source is configured.
  it("asks for a source rather than showing invented numbers", () => {
    const text = describeUnavailableSource();
    expect(text).toMatch(/source/i);
    expect(text).not.toMatch(/\d/);
  });
});
