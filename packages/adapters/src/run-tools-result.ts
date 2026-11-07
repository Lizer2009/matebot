import type {
  BuildResultSurfaceResult,
  ResultAggregation,
  ResultColumn,
  ResultSourceRead,
} from "@matebot/core";
import { buildResultSurface, validateResultProvenance } from "@matebot/core";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import { loadOwnerEmailConnections } from "./interaction-email-capability.js";
import { publishResultSurface } from "./interaction-result-publish.js";
import { calendarResultReader } from "./result-source-calendar.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { modelRowProvenance, resolveSourceBackedRows } from "./run-tools-result-source.js";

/**
 * `present_result`: the model posting a read-only result card.
 *
 * There are two ways a card gets its numbers, and the card says which one:
 *
 * - The model names a registered source id and a window. The server reads the
 *   data through that source with the user's own connection and computes any
 *   requested sums itself. This is the path the spec means by "aggregation is
 *   computed by deterministic code over real data".
 * - The model passes rows it already has. They are shown, but the provenance
 *   line states they did not come from a data source, so a reader is never told
 *   that an unverified figure was measured.
 *
 * Either way it creates no effect: a result can never send or write.
 */

export type PresentResultArgs = {
  title?: unknown;
  sourceId?: unknown;
  from?: unknown;
  to?: unknown;
  groupBy?: unknown;
  metrics?: unknown;
  source?: unknown;
  asOf?: unknown;
  window?: unknown;
  units?: unknown;
  timezone?: unknown;
  year?: unknown;
  freshness?: unknown;
  columns?: unknown;
  rows?: unknown;
};

function parseColumns(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const columns = value
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => ({
      key: typeof entry.key === "string" ? entry.key.trim() : "",
      label: typeof entry.label === "string" ? entry.label.trim() : "",
      ...(entry.align === "end"
        ? { align: "end" as const }
        : entry.align === "start"
          ? { align: "start" as const }
          : {}),
    }))
    .filter((column) => column.key && column.label);
  return columns.length > 0 ? columns : undefined;
}

/** Parse the aggregation the model asked for; anything malformed is refused. */
export function parseMetrics(value: unknown): ResultAggregation["metrics"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const metrics = value
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => ({
      key: typeof entry.key === "string" ? entry.key.trim() : "",
      op: entry.op,
      of: typeof entry.of === "string" ? entry.of.trim() : undefined,
    }))
    .filter(
      (entry) =>
        entry.key &&
        (entry.op === "sum" ||
          entry.op === "count" ||
          entry.op === "avg" ||
          entry.op === "min" ||
          entry.op === "max"),
    );
  return metrics.length > 0 ? (metrics as ResultAggregation["metrics"]) : undefined;
}

/**
 * Validate the tool's arguments into a bounded surface, or explain why not.
 * Exported so the tool's refusals are testable without a database.
 */
export function buildResultFromArgs(args: PresentResultArgs): BuildResultSurfaceResult {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { ok: false, error: "missing_title" };
  const provenance = validateResultProvenance({
    source: args.source,
    asOf: args.asOf,
    window: args.window,
    units: args.units,
    timezone: args.timezone,
    year: args.year,
    freshness: args.freshness,
  });
  if (!provenance.ok) return { ok: false, error: provenance.error };
  return buildResultSurface({
    title,
    // Rows the model wrote are never labelled as read from a source.
    provenance: modelRowProvenance(provenance.provenance),
    columns: parseColumns(args.columns),
    rows: Array.isArray(args.rows) ? args.rows : [],
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type PresentResultDeps = {
  /** The user's own connection for a source that needs one. */
  connectionFor: (app: "email" | "calendar") => Promise<string | null>;
  /** A per-turn reader for a source that needs the user's provider connection. */
  read?: ResultSourceRead;
};

export function presentResultDeps(ctx: RunContext): PresentResultDeps {
  const { deps, run } = ctx;
  const connectionFor = async (app: "email" | "calendar") => {
    const connections = await loadOwnerEmailConnections(deps.prisma, {
      spaceId: run.spaceId,
      userId: run.userId,
    });
    const match = connections.find(
      (row) =>
        row.status === "connected" &&
        (app === "calendar" ? /calendar/i.test(row.provider) : /gmail|mail/i.test(row.provider)),
    );
    return match?.id ?? null;
  };

  return {
    connectionFor,
    // The calendar is the one source that reads through the provider. Its reader
    // is built from this run's connector so a read happens with this user's own
    // connection and nothing outlives the turn.
    read: async (input) => {
      const connector = deps.connector ?? deps.connectors?.managed("composio");
      const connectionId = input.connectionId ?? (await connectionFor("calendar"));
      if (!connector || !connectionId) {
        return { ok: false, error: "needs_connection", outcome: "unavailable" };
      }
      const reader = calendarResultReader({
        connector,
        context: {
          operationId: "interaction.calendar.read",
          traceId: "interaction.calendar.read",
          spaceId: run.spaceId,
          userId: run.userId,
          signal: new AbortController().signal,
        },
        connectionId,
      });
      if (!reader) return { ok: false, error: "needs_connection", outcome: "unavailable" };
      return reader(input);
    },
  };
}

/** Turn the arguments into a surface, reading the source when one was named. */
export async function surfaceFromArgs(
  args: PresentResultArgs,
  deps: PresentResultDeps,
): Promise<BuildResultSurfaceResult> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { ok: false, error: "missing_title" };
  const sourceId = text(args.sourceId);

  if (sourceId) {
    const from = text(args.from);
    const to = text(args.to);
    if (!from || !to) return { ok: false, error: "invalid_window" };
    const resolved = await resolveSourceBackedRows(
      {
        sourceId,
        from,
        to,
        ...(text(args.timezone) ? { timezone: text(args.timezone) } : {}),
        ...(text(args.groupBy) ? { groupBy: text(args.groupBy) } : {}),
        ...(parseMetrics(args.metrics) ? { metrics: parseMetrics(args.metrics) } : {}),
        ...(parseColumns(args.columns) ? { columns: parseColumns(args.columns) } : {}),
      },
      deps,
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return buildResultSurface({
      title,
      provenance: resolved.provenance,
      rows: resolved.rows,
      ...(resolved.columns ? { columns: resolved.columns } : {}),
    });
  }

  return buildResultFromArgs(args);
}

export async function presentResult(
  ctx: RunContext,
  args: PresentResultArgs,
  resultDeps: PresentResultDeps = presentResultDeps(ctx),
): Promise<
  | { ok: true; interactionId: string; surfaceId: string; messageId: string; reply: string }
  | { ok: false; error: string; reply?: string }
> {
  if (!isA2uiFeatureEnabled()) {
    return { ok: false, error: "Interactive cards are not enabled on this server." };
  }
  const built = await surfaceFromArgs(args, resultDeps);
  if (!built.ok) {
    // Tell the model what to do instead of showing a card with no source.
    const reply =
      built.error === "missing_source"
        ? "I need to know where these numbers came from before I can show them."
        : built.error === "needs_connection"
          ? "需要先连接数据来源才能读取。"
          : built.error === "unknown_source"
            ? "没有这个数据来源，请告诉我要从哪里读取。"
            : undefined;
    return { ok: false, error: built.error, ...(reply ? { reply } : {}) };
  }

  const { deps, run } = ctx;
  const result = await publishResultSurface(
    {
      prisma: deps.prisma,
      appendEvent: async (tx, input) => {
        const { appendEventInTransaction } = await import("@matebot/db");
        return appendEventInTransaction(tx as never, input as never);
      },
      notify: async (threadId, seq) => {
        await deps.events.notify(threadId, seq);
      },
    },
    {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      intent: "interaction.result",
      surface: built.surface,
      surfaceId: `surface-${crypto.randomUUID()}`,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    interactionId: result.interactionId,
    surfaceId: result.surfaceId,
    messageId: result.messageId,
    // The one short line; the card carries the rows and the source.
    reply: built.surface.empty ? "没有查到该范围内的数据，已注明来源。" : "结果已放在卡片上。",
  };
}

export const resultTools: ToolHandlers = {
  async present_result(ctx, call) {
    return call.finish(await presentResult(ctx, call.args as PresentResultArgs));
  },
};

export type { ResultColumn };
export type { ToolCall };
