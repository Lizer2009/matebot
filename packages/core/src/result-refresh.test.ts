import type { ResultSurface } from "@matebot/contracts";
import { acceptSurfaceEvent, refreshResultSurface } from "@matebot/core";
import { describe, expect, it } from "vitest";

/**
 * "Show this year" then "now show last quarter": the second turn must update the
 * same card, keep its source and units, and never touch another card. A refresh
 * that changes the window is a view change; it is not a new card and not a write.
 */

const base: ResultSurface = {
  title: "Annual sales",
  provenance: {
    source: "user-provided CSV",
    asOf: "2026-11-06T00:00:00.000Z",
    window: { from: "2026-01-01", to: "2026-12-31" },
    units: "CNY",
    timezone: "Asia/Shanghai",
  },
  columns: [{ key: "quarter", label: "Quarter" }],
  rows: [{ quarter: "Q1" }, { quarter: "Q2" }],
  truncated: false,
  totalRows: 2,
  empty: false,
};

describe("refreshResultSurface", () => {
  it("replaces the window and rows while keeping source, units and zone", () => {
    const next = refreshResultSurface(base, {
      revision: 2,
      window: { from: "2026-07-01", to: "2026-09-30" },
      rows: [{ quarter: "Q3" }],
    });
    expect(next).toMatchObject({ ok: true });
    if (!next.ok) return;
    expect(next.surface.provenance.window).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
    // Provenance that did not change stays put; it is not re-invented.
    expect(next.surface.provenance.source).toBe("user-provided CSV");
    expect(next.surface.provenance.units).toBe("CNY");
    expect(next.surface.provenance.timezone).toBe("Asia/Shanghai");
    expect(next.surface.rows).toEqual([{ quarter: "Q3" }]);
    expect(next.revision).toBe(2);
  });

  // The card the user is looking at is the one that changes.
  it("keeps the same surface identity", () => {
    const next = refreshResultSurface(base, {
      revision: 3,
      window: { from: "2026-10-01", to: "2026-12-31" },
      rows: [],
    });
    expect(next).toMatchObject({ ok: true });
    if (!next.ok) return;
    expect(next.surfaceTitle).toBe("Annual sales");
  });

  it("marks a refresh that returns nothing as empty rather than zero", () => {
    const next = refreshResultSurface(base, {
      revision: 2,
      window: { from: "2027-01-01", to: "2027-03-31" },
      rows: [],
    });
    expect(next).toMatchObject({ ok: true });
    if (!next.ok) return;
    expect(next.surface.empty).toBe(true);
    expect(next.surface.emptyNotice).toBeTruthy();
  });

  it("refuses a refresh with an invalid window", () => {
    const next = refreshResultSurface(base, {
      revision: 2,
      window: { from: "2026-12-31", to: "2026-01-01" },
      rows: [],
    });
    expect(next).toMatchObject({ ok: false });
  });

  it("refuses a refresh that tries to change the source silently", () => {
    // Changing where the numbers came from is a new query, not a view change.
    const next = refreshResultSurface(base, {
      revision: 2,
      window: { from: "2026-07-01", to: "2026-09-30" },
      rows: [{ quarter: "Q3" }],
      source: "a different spreadsheet",
    });
    expect(next).toMatchObject({ ok: false, error: "source_changed" });
  });
});

describe("stale refresh rejection", () => {
  const state = {
    taskId: "task-1",
    surfaceId: "s-1",
    revision: 4,
    status: "draft" as const,
    values: {},
    editedFields: [],
  };

  it("drops a refresh built on an older revision", () => {
    expect(acceptSurfaceEvent(state, { revision: 3 })).toMatchObject({
      accept: false,
      reason: "stale",
    });
    // Equal revisions are replays, dropped for the same reason.
    expect(acceptSurfaceEvent(state, { revision: 4 })).toMatchObject({
      accept: false,
      reason: "stale",
    });
    expect(acceptSurfaceEvent(state, { revision: 5 })).toMatchObject({ accept: true });
  });
});
