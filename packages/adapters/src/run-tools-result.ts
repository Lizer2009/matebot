import type { BuildResultSurfaceResult } from "@matebot/core";
import { buildResultSurface } from "@matebot/core";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import { publishResultSurface } from "./interaction-result-publish.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/**
 * `present_result`: the model posting a read-only result card.
 *
 * This is the production entry for P2. It takes computed rows plus provenance,
 * validates and bounds them, and publishes through the same tables and SSE the
 * draft path uses. It creates no effect, so a result can never send or write;
 * and it refuses rows without a source, so a card cannot show numbers the server
 * cannot attribute.
 */

export type PresentResultArgs = {
  title?: unknown;
  source?: unknown;
  asOf?: unknown;
  window?: unknown;
  units?: unknown;
  timezone?: unknown;
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

/**
 * Validate the tool's arguments into a bounded surface, or explain why not.
 * Exported so the tool's refusals are testable without a database.
 */
export function buildResultFromArgs(args: PresentResultArgs): BuildResultSurfaceResult {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { ok: false, error: "missing_title" };
  return buildResultSurface({
    title,
    provenance: {
      source: args.source,
      asOf: args.asOf,
      window: args.window,
      units: args.units,
      timezone: args.timezone,
    },
    columns: parseColumns(args.columns),
    rows: Array.isArray(args.rows) ? args.rows : [],
  });
}

export async function presentResult(
  ctx: RunContext,
  args: PresentResultArgs,
): Promise<
  | { ok: true; interactionId: string; surfaceId: string; messageId: string; reply: string }
  | { ok: false; error: string; reply?: string }
> {
  if (!isA2uiFeatureEnabled()) {
    return { ok: false, error: "Interactive cards are not enabled on this server." };
  }
  const built = buildResultFromArgs(args);
  if (!built.ok) {
    // Tell the model what to do instead of showing a card with no source.
    const reply =
      built.error === "missing_source"
        ? "I need to know where these numbers came from before I can show them."
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

export type { ToolCall };
