import type { ResultSourceRead } from "@matebot/core";
import { queryResultSource, windowDecision } from "@matebot/core";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import type { publishResultSurface } from "./interaction-result-publish.js";
import { calendarResultReader } from "./result-source-calendar.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/**
 * `refresh_result`: re-read a registered source for a new window and update the
 * same card.
 *
 * This is the difference between relabelling rows and actually re-querying. The
 * read goes through a registered source, which owns its connection requirement
 * and performs the fetch itself; the model supplies only a source id and a
 * window. It creates no external effect, so a refresh can never send or write,
 * and it reports the new provenance rather than carrying the old window forward.
 */

export type RefreshResultArgs = {
  interactionId?: unknown;
  sourceId?: unknown;
  from?: unknown;
  to?: unknown;
  timezone?: unknown;
  revision?: unknown;
  /** True when the assistant chose the period because the user named none. */
  defaultedWindow?: unknown;
};

export type RefreshResultServices = {
  /** The interaction to update, so a refresh targets one card. */
  loadInteraction: (interactionId: string) => Promise<{
    id: string;
    spaceId: string;
    threadId: string;
    intent: string;
    draftVersion: number;
    title: string | null;
    slots: Record<string, unknown>;
  } | null>;
  listOpenResults: (input: {
    spaceId: string;
    threadId: string;
  }) => Promise<Array<{ taskId: string; label: string }>>;
  /** The user's connection for the source, when it needs one. */
  connectionFor: (app: "email" | "calendar") => Promise<string | null>;
  /** A per-turn reader for a source that reads through the user's provider. */
  read?: ResultSourceRead;
  /** The prompt this run is answering, so the server can tell whose period this is. */
  userPrompt?: string | null;
  /** Republish the same interaction's surface with the new result. */
  republish: (input: {
    interactionId: string;
    surfaceId: string;
    surface: Parameters<typeof publishResultSurface>[1]["surface"];
    draftVersion: number;
  }) => Promise<{ ok: true; draftVersion: number } | { ok: false; error: string }>;
};

export type RefreshResultOutcome =
  | {
      ok: true;
      interactionId: string;
      draftVersion: number;
      rows: number;
      totalRows: number;
      truncated: boolean;
      provenance: Record<string, unknown>;
      reply: string;
    }
  | {
      ok: false;
      error: string;
      candidates?: Array<{ interactionId: string; label: string }>;
      reply?: string;
    };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function refreshResult(
  ctx: RunContext,
  args: RefreshResultArgs,
  services: RefreshResultServices,
): Promise<RefreshResultOutcome> {
  if (!isA2uiFeatureEnabled()) {
    return { ok: false, error: "Interactive cards are not enabled on this server." };
  }
  const sourceId = text(args.sourceId);
  const from = text(args.from);
  const to = text(args.to);
  if (!sourceId) return { ok: false, error: "missing_source" };
  if (!from || !to) return { ok: false, error: "invalid_window" };
  // A refresh re-reads a different window on a card the person is looking at. The
  // same rule as a first result applies: a period nobody stated and nobody admitted
  // choosing is asked about, not silently substituted for the one on the card.
  const window = windowDecision({
    claimedByModel: args.defaultedWindow === true,
    userPrompt: services.userPrompt,
  });
  if (window === "unstated") {
    return {
      ok: false,
      error: "unstated_window",
      reply: "Which dates should I cover? Tell me the period and I will read it.",
    };
  }

  // Which card? An unnamed reference with several results must be clarified.
  const open = await services.listOpenResults({
    spaceId: ctx.run.spaceId,
    threadId: ctx.run.threadId,
  });
  const named = text(args.interactionId);
  if (!named && open.length > 1) {
    return {
      ok: false,
      error: "ambiguous_target",
      candidates: open.map((entry) => ({ interactionId: entry.taskId, label: entry.label })),
      reply: `你指的是哪张卡片？${open.map((entry) => entry.label).join("、")}`,
    };
  }
  const target = named ? open.find((entry) => entry.taskId === named) : open[0];
  if (!target) return { ok: false, error: "no_open_result" };

  const row = await services.loadInteraction(target.taskId);
  if (!row) return { ok: false, error: "unknown_interaction" };
  if (row.spaceId !== ctx.run.spaceId || row.threadId !== ctx.run.threadId) {
    return { ok: false, error: "forbidden" };
  }
  // A stale revision means the model refreshed a card the user has since changed.
  const revision = typeof args.revision === "number" ? args.revision : row.draftVersion;
  if (revision !== row.draftVersion) return { ok: false, error: "stale_revision" };

  // The read goes through the registered source; a source that needs a
  // connection only reads with the user's own bound connection.
  const timezone = text(args.timezone) || undefined;
  const source = (await import("@matebot/core")).findResultSource(sourceId);
  const connectionId = source?.requiresConnection
    ? await services.connectionFor(source.requiresConnection)
    : null;
  const queried = await queryResultSource(
    { sourceId, window: { from, to }, ...(timezone ? { timezone } : {}) },
    {
      connectionId,
      ...(services.read
        ? { readFor: (id: string) => (id === "calendar-events" ? services.read : undefined) }
        : {}),
    },
  );
  if (!queried.ok) {
    const reply =
      queried.error === "needs_connection"
        ? "需要先连接数据来源才能按新范围重新查询。"
        : queried.error === "unknown_source"
          ? "没有这个数据来源，请告诉我要从哪里读取。"
          : undefined;
    return { ok: false, error: queried.error, ...(reply ? { reply } : {}) };
  }

  const { buildResultSurface } = await import("@matebot/core");
  const built = buildResultSurface({
    title: row.title ?? "Result",
    provenance: {
      ...queried.provenance,
      ...(window === "assumed" ? { defaultedWindow: true } : {}),
    },
    rows: queried.rows,
  });
  if (!built.ok) return { ok: false, error: built.error };

  const surfaceRow = await services.republish({
    interactionId: row.id,
    surfaceId: row.id,
    surface: built.surface,
    draftVersion: row.draftVersion,
  });
  if (!surfaceRow.ok) return { ok: false, error: surfaceRow.error };

  return {
    ok: true,
    interactionId: row.id,
    draftVersion: surfaceRow.draftVersion,
    rows: built.surface.rows.length,
    totalRows: built.surface.totalRows,
    truncated: built.surface.truncated,
    provenance: { ...built.surface.provenance },
    reply: built.surface.empty
      ? "该范围内没有数据，已注明来源。"
      : built.surface.provenance.defaultedWindow
        ? "已按新范围更新卡片；日期是默认范围，不是你说的。"
        : "已按新范围更新卡片。",
  };
}

/**
 * Services built from the run's own deps, so the tool is wired in production
 * rather than relying on a caller to inject them.
 */
export function refreshResultServices(ctx: RunContext): RefreshResultServices {
  const { deps, run } = ctx;
  const prisma = deps.prisma;
  const connectionForApp = async (app: "email" | "calendar") => {
    const { loadOwnerEmailConnections } = await import("./interaction-email-capability.js");
    const connections = await loadOwnerEmailConnections(prisma, {
      spaceId: run.spaceId,
      userId: run.userId,
    });
    // Only a connected row counts; a pending or revoked one is not a read source.
    const match = connections.find(
      (row) =>
        row.status === "connected" &&
        (app === "calendar" ? /calendar/i.test(row.provider) : /gmail|mail/i.test(row.provider)),
    );
    return match?.id ?? null;
  };
  return {
    userPrompt: ctx.task?.prompt ?? null,
    loadInteraction: async (interactionId) => {
      const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
      if (!row) return null;
      return {
        id: row.id,
        spaceId: row.spaceId,
        threadId: row.threadId,
        intent: row.intent,
        draftVersion: row.draftVersion,
        title: row.title,
        slots:
          row.slots && typeof row.slots === "object" && !Array.isArray(row.slots)
            ? (row.slots as Record<string, unknown>)
            : {},
      };
    },
    listOpenResults: async ({ spaceId, threadId }) => {
      const rows = await prisma.interaction.findMany({
        where: { spaceId, threadId, status: { notIn: ["cancelled", "failed"] } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, intent: true },
      });
      return rows
        .filter((row) => row.intent === "interaction.result")
        .map((row) => ({ taskId: row.id, label: row.title ?? row.id }));
    },
    read: async (input) => {
      const connector = deps.connector ?? deps.connectors?.managed("composio");
      const connectionId = input.connectionId ?? (await connectionForApp("calendar"));
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
    connectionFor: connectionForApp,
    republish: async (input) => {
      const { republishResultSurface } = await import("./interaction-result-publish.js");
      const republished = await republishResultSurface(
        {
          prisma,
          appendEvent: async (tx, eventInput) => {
            const { appendEventInTransaction } = await import("@matebot/db");
            return appendEventInTransaction(tx as never, eventInput as never);
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
          interactionId: input.interactionId,
          surface: input.surface,
        },
      );
      return republished.ok
        ? { ok: true as const, draftVersion: republished.draftVersion }
        : { ok: false as const, error: republished.error };
    },
  };
}

export const refreshResultTools: ToolHandlers = {
  async refresh_result(ctx, call) {
    return call.finish(
      await refreshResult(ctx, call.args as RefreshResultArgs, refreshResultServices(ctx)),
    );
  },
};

export type { ToolCall };
