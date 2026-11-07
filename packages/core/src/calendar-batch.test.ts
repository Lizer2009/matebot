import { describe, expect, it } from "vitest";
import { batchIsRequested, batchResultRows, summarizeBatch } from "./calendar-batch.js";

/**
 * A partial batch must be distinguishable from a complete one.
 *
 * The failure this guards against is a card that says "done" when one of three
 * events failed, so the summary is computed from per-item outcomes and the notice
 * is checked for the cases that matter.
 */

const ok = (label: string) => ({ label, state: "succeeded" as const });

describe("summarizeBatch", () => {
  it("says everything was done only when every item succeeded", () => {
    const summary = summarizeBatch([ok("A"), ok("B")]);
    expect(summary).toMatchObject({ total: 2, succeeded: 2, complete: true, partial: false });
    expect(summary.notice).toBe("已完成全部 2 项。");
  });

  it("distinguishes a partial batch and never reads as complete", () => {
    const summary = summarizeBatch([
      ok("A"),
      ok("B"),
      { label: "C", state: "failed", error: "declined" },
    ]);
    expect(summary).toMatchObject({
      total: 3,
      succeeded: 2,
      failed: 1,
      complete: false,
      partial: true,
    });
    expect(summary.notice).toContain("已完成 2 项");
    expect(summary.notice).toContain("1 项失败");
    expect(summary.notice).not.toContain("全部");
  });

  it("keeps an unknown outcome separate from a failure", () => {
    const summary = summarizeBatch([ok("A"), { label: "B", state: "unknown" }]);
    expect(summary).toMatchObject({ succeeded: 1, failed: 0, unknown: 1, partial: true });
    expect(summary.notice).toContain("待核对");
  });

  it("does not call a wholly failed batch partial", () => {
    const summary = summarizeBatch([
      { label: "A", state: "failed" },
      { label: "B", state: "failed" },
    ]);
    expect(summary).toMatchObject({ succeeded: 0, failed: 2, partial: false, complete: false });
    expect(summary.notice).toBe("全部 2 项都没有完成。");
  });

  it("describes an empty batch without claiming success", () => {
    const summary = summarizeBatch([]);
    expect(summary).toMatchObject({ total: 0, complete: false, partial: false });
    expect(summary.notice).toBe("没有需要处理的条目。");
  });
});

describe("batchResultRows", () => {
  it("gives every requested item a row, including the failed ones", () => {
    const { rows, columns } = batchResultRows([
      ok("A"),
      { label: "B", state: "failed", error: "declined" },
    ]);
    expect(rows).toEqual([
      { item: "A", state: "succeeded", error: null },
      { item: "B", state: "failed", error: "declined" },
    ]);
    expect(columns.map((column) => column.key)).toEqual(["item", "state", "error"]);
  });
});

describe("batchIsRequested", () => {
  it("does not fan a single request out into a batch", () => {
    expect(batchIsRequested({ items: ["one"] })).toBe(false);
    expect(batchIsRequested({ items: ["one", "two"] })).toBe(true);
  });
});
