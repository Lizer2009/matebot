import type { ResultAggregation, ResultColumn, ResultRow, ResultSourceRead } from "@matebot/core";
import { aggregateResultRows, findResultSource, queryResultSource } from "@matebot/core";

/**
 * Where a result card's numbers come from, and how the card says so.
 *
 * Two paths, and the difference is visible on the card:
 *
 * - `source`: the model named a registered source and a window; the server read
 *   the rows and did the arithmetic itself. This is what satisfies "aggregation
 *   is computed by deterministic code over real data".
 * - `model`: the model wrote the rows. Nothing verified them, so the provenance
 *   line says "not from a data source" instead of borrowing a source's name.
 *
 * Keeping both here means the honest label is applied in one place rather than
 * by every caller remembering to.
 */

export type SourceBackedResultInput = {
  sourceId: string;
  from: string;
  to: string;
  timezone?: string;
  groupBy?: string;
  metrics?: ResultAggregation["metrics"];
  columns?: ResultColumn[];
};

export type ResolveResultRowsDeps = {
  /** The user's own connection id for an app, or null when there is none. */
  connectionFor: (app: "email" | "calendar") => Promise<string | null>;
  /**
   * The reader for a source that needs the user's provider connection. Built
   * from this turn's connector, so no reader outlives the turn or crosses users.
   */
  read?: ResultSourceRead;
};

export type ResolveResultRowsOutcome =
  | {
      ok: true;
      rows: ResultRow[];
      columns?: ResultColumn[];
      provenance: Record<string, unknown>;
    }
  | { ok: false; error: string; reply?: string };

/**
 * Read a registered source and aggregate it, or explain why the card cannot be
 * drawn. An empty window is a real answer and comes back as zero rows, which the
 * card renders as "no data" rather than as zeros.
 */
export async function resolveSourceBackedRows(
  input: SourceBackedResultInput,
  deps: ResolveResultRowsDeps,
): Promise<ResolveResultRowsOutcome> {
  const source = findResultSource(input.sourceId);
  if (!source) {
    return {
      ok: false,
      error: "unknown_source",
      reply: "没有这个数据来源，请告诉我要从哪里读取。",
    };
  }
  const connectionId = source.requiresConnection
    ? await deps.connectionFor(source.requiresConnection)
    : null;
  if (source.requiresConnection && !connectionId) {
    return {
      ok: false,
      error: "needs_connection",
      reply: "需要先连接数据来源才能读取。",
    };
  }

  const queried = await queryResultSource(
    {
      sourceId: input.sourceId,
      window: { from: input.from, to: input.to },
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
    {
      connectionId,
      ...(deps.read
        ? { readFor: (id: string) => (id === "calendar-events" ? deps.read : undefined) }
        : {}),
    },
  );
  if (!queried.ok) return { ok: false, error: queried.error };

  let rows = queried.rows as ResultRow[];
  let columns = input.columns;
  if (input.metrics?.length) {
    const aggregated = aggregateResultRows(
      { rows, ...(columns ? { columns } : {}) },
      { ...(input.groupBy ? { groupBy: input.groupBy } : {}), metrics: input.metrics },
    );
    if (!aggregated.ok) return { ok: false, error: aggregated.error };
    rows = aggregated.rows;
    columns = aggregated.columns;
  }

  return {
    ok: true,
    rows,
    ...(columns ? { columns } : {}),
    provenance: { ...queried.provenance, attribution: "source" },
  };
}

/**
 * Rows the model wrote are still shown on request, but the card must not imply a
 * data source vouched for them.
 */
export function modelRowProvenance(provenance: Record<string, unknown>): Record<string, unknown> {
  return { ...provenance, attribution: "model" };
}
