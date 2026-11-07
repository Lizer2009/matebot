import type { MessageBlock } from "@matebot/contracts";
import type {
  BuildResultSurfaceResult,
  ResultAggregation,
  ResultColumn,
  ResultSourceRead,
} from "@matebot/core";
import { buildResultSurface, validateResultProvenance, windowDecision } from "@matebot/core";
import { getLogger } from "@matebot/logging";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import { loadOwnerEmailConnections } from "./interaction-email-capability.js";
import { publishResultSurface } from "./interaction-result-publish.js";
import { calendarResultReader } from "./result-source-calendar.js";
import { csvResultReader } from "./result-source-csv.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { resolveSourceBackedRows } from "./run-tools-result-source.js";

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
  /** True when the assistant chose the period because the user named none. */
  defaultedWindow?: unknown;
  /** A specific uploaded file to read, when the model knows which one. */
  artifactId?: unknown;
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

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type PresentResultDeps = {
  /** The user's own connection for a source that needs one. */
  connectionFor: (app: "email" | "calendar") => Promise<string | null>;
  /**
   * What the person actually asked, so the server can decide whether the period
   * was theirs or the assistant's. Absent in a test that does not care.
   */
  userPrompt?: string | null;
  /**
   * A per-turn reader, asked for by source id. Each source that cannot be read
   * from a shared registry (the calendar through a connector, a file through this
   * turn's artifacts) supplies one; anything else uses the registered reader.
   */
  read?: ResultSourceRead;
  csvRead?: ResultSourceRead;
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
    userPrompt: ctx.task?.prompt ?? null,
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
    // The uploaded file, read from this user's own artifact store. The candidate
    // list is the file(s) on the message that started this run, resolved lazily
    // so a turn that never asks for a result does no extra query.
    csvRead: deps.artifacts
      ? async (input) => {
          const attachedArtifactIds = await attachedFileArtifactIds(run.sourceMessageId, deps);
          const reader = csvResultReader(
            {
              artifacts: {
                find: (artifactId) =>
                  deps.prisma.artifact.findFirst({
                    where: { id: artifactId, spaceId: run.spaceId, userId: run.userId },
                    select: { id: true, name: true, mimeType: true, storageKey: true },
                  }),
                read: (storageKey) =>
                  deps.artifacts!.get(storageKey, {
                    operationId: "interaction.result.read",
                    traceId: "interaction.result.read",
                    spaceId: run.spaceId,
                    userId: run.userId,
                    signal: new AbortController().signal,
                  }),
              },
              attachedArtifactIds,
            },
            input.artifactId ? { artifactId: input.artifactId } : {},
          );
          if (!reader) return { ok: false, error: "no_uploaded_file", outcome: "unavailable" };
          return reader(input);
        }
      : undefined,
  };
}

/**
 * The files attached to the message that started this run.
 *
 * Read from that message's own blocks. Only artifacts the same person attached are
 * in scope, and the newest is tried first, so the file the user just handed over
 * is the one read.
 */
async function attachedFileArtifactIds(
  sourceMessageId: string | null | undefined,
  deps: RunContext["deps"],
): Promise<string[]> {
  if (!sourceMessageId) return [];
  const message = await deps.prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(message?.blocks) ? (message.blocks as MessageBlock[]) : [];
  return blocks
    .filter((block): block is Extract<MessageBlock, { kind: "file" }> => block.kind === "file")
    .map((block) => block.artifactId);
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
    // Nobody stated a period and nobody admitted choosing one. Publishing here
    // would put a figure on a window the person never asked about, which is what
    // the audit's flight answer did. The turn asks instead.
    const window = windowDecision({
      claimedByModel: args.defaultedWindow === true,
      userPrompt: deps.userPrompt,
    });
    if (window === "unstated") return { ok: false, error: "unstated_window" };
    const resolved = await resolveSourceBackedRows(
      {
        sourceId,
        from,
        to,
        ...(text(args.timezone) ? { timezone: text(args.timezone) } : {}),
        ...(text(args.groupBy) ? { groupBy: text(args.groupBy) } : {}),
        ...(parseMetrics(args.metrics) ? { metrics: parseMetrics(args.metrics) } : {}),
        ...(parseColumns(args.columns) ? { columns: parseColumns(args.columns) } : {}),
        ...(text(args.artifactId) ? { artifactId: text(args.artifactId) } : {}),
        // The server decides, from the person's own words: a model that reports an
        // invented period as their choice is the defect, so its own claim is not the
        // final word.
        ...(window === "assumed" ? { defaultedWindow: true } : {}),
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

  // Rows the model wrote are not a data source. Presenting them would make the
  // server vouch for numbers nothing read, and a label saying so is not evidence
  // (§5.6.2). The model is told to name a source instead, or to answer in prose.
  return { ok: false, error: "missing_source" };
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
    // A refusal is worth a line: it says which source was asked for and why the
    // read did not happen, which is otherwise invisible to an operator.
    getLogger().warn("a2ui.result_refused", {
      "result.error": built.error,
      "result.source_id": typeof args.sourceId === "string" ? args.sourceId : "none",
    });
    // Tell the model what to do instead of showing a card with no source.
    const reply =
      built.error === "missing_source"
        ? "I need to know where these numbers came from before I can show them."
        : built.error === "unstated_window"
          ? "Which dates should I cover? Tell me the period and I will read it."
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
    reply: resultReplyText(built.surface),
  };
}

/**
 * The single sentence that accompanies a published result.
 *
 * It is produced by the server from the surface it just published, and not written
 * by the model, so a window the server had to choose is stated in the reply as well
 * as on the card. The model can then only repeat it, not restate it as the
 * person's own choice.
 */
export function resultReplyText(surface: {
  empty: boolean;
  provenance: { defaultedWindow?: boolean };
}): string {
  if (surface.empty) return "没有查到该范围内的数据，已注明来源。";
  return surface.provenance.defaultedWindow
    ? "结果已放在卡片上；日期是默认范围，不是你说的。"
    : "结果已放在卡片上。";
}

export const resultTools: ToolHandlers = {
  async present_result(ctx, call) {
    return call.finish(await presentResult(ctx, call.args as PresentResultArgs));
  },
};

export type { ResultColumn, ToolCall };
