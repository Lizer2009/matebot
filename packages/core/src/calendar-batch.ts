import type { ResultColumn, ResultRow } from "./interaction-result.js";

/**
 * Outcomes of a batch, and how a card distinguishes them.
 *
 * Spec §5.4.2 requires a partial batch to be visible: if three events were asked
 * for and one failed, the card must say two happened and one did not, not "done".
 * A batch is only ever a batch because the user asked for one — nothing here
 * creates anything on its own — and the summary is computed from the recorded
 * per-item outcomes rather than from a count the caller supplied.
 */

export type BatchItemState = "succeeded" | "failed" | "unknown";

export type BatchItem = {
  /** Stable label for the item, e.g. the event name the user gave. */
  label: string;
  state: BatchItemState;
  error?: string;
};

export type BatchSummary = {
  total: number;
  succeeded: number;
  failed: number;
  unknown: number;
  /** True when every item succeeded, so a host can say "done" plainly. */
  complete: boolean;
  /** True when some but not all succeeded: the case that must never read as done. */
  partial: boolean;
  /** The sentence the card shows; never claims more than the recorded outcomes. */
  notice: string;
};

export function summarizeBatch(items: readonly BatchItem[]): BatchSummary {
  const succeeded = items.filter((item) => item.state === "succeeded").length;
  const failed = items.filter((item) => item.state === "failed").length;
  const unknown = items.filter((item) => item.state === "unknown").length;
  const total = items.length;
  const complete = total > 0 && succeeded === total;
  const partial = succeeded > 0 && succeeded < total;

  let notice: string;
  if (total === 0) {
    notice = "没有需要处理的条目。";
  } else if (complete) {
    notice = `已完成全部 ${total} 项。`;
  } else if (succeeded === 0) {
    notice =
      unknown > 0
        ? `没有一项确认完成，其中 ${unknown} 项结果待核对。`
        : `全部 ${total} 项都没有完成。`;
  } else if (unknown > 0) {
    notice = `已完成 ${succeeded} 项，${failed} 项失败，${unknown} 项结果待核对。`;
  } else {
    notice = `已完成 ${succeeded} 项，另有 ${failed} 项失败。`;
  }

  return { total, succeeded, failed, unknown, complete, partial, notice };
}

/**
 * The per-item rows a partial batch card shows. One row per requested item, so a
 * failed item is present in the table rather than only in a count.
 */
export function batchResultRows(items: readonly BatchItem[]): {
  rows: ResultRow[];
  columns: ResultColumn[];
} {
  return {
    rows: items.map((item) => ({
      item: item.label,
      state: item.state,
      error: item.error ?? null,
    })),
    columns: [
      { key: "item", label: "Item" },
      { key: "state", label: "State" },
      { key: "error", label: "Error" },
    ],
  };
}

/**
 * Whether a batch may be attempted at all. Batch creation only happens when the
 * user asked for several items; a single request never fans out on its own.
 */
export function batchIsRequested(input: { items: readonly unknown[] }): boolean {
  return input.items.length > 1;
}
