import type { AdapterContext, ConnectorProvider } from "@matebot/adapter-kit";
import type { ResultSourceRead } from "@matebot/core";
import { readCalendarEvents } from "./interaction-calendar.js";
import type { InteractionCalendarSender } from "./interaction-calendar.js";

/**
 * The calendar read source, wired to the run's own connector.
 *
 * `calendar-events` is a registered source, but a source cannot hold a live
 * connector: it would then carry one user's credentials to another's read. The
 * run builds this reader from its own connector and connection for the duration
 * of the call and hands it to `queryResultSource` as `read`. When the run has no
 * calendar connection the reader is not offered at all, and the query refuses
 * with `needs_connection` before any read happens.
 */
export function calendarResultReader(input: {
  connector: Pick<ConnectorProvider, "execute">;
  context: AdapterContext;
  connectionId: string | null;
}): ResultSourceRead | undefined {
  if (!input.connectionId) return undefined;
  return async ({ window, timezone }) => {
    const sender: InteractionCalendarSender = {
      kind: "connector",
      context: input.context,
      connector: input.connector,
      connectionId: input.connectionId ?? undefined,
    };
    const read = await readCalendarEvents(
      {
        from: window.from,
        to: window.to,
        timezone,
        // Reading has no effect to protect from a retry; the key only names the
        // provider call so a duplicate read is recognizable in a trace.
        idempotencyKey: `calendar-read-${window.from}-${window.to}`,
      },
      sender,
    );
    if (!read.ok) {
      return {
        ok: false,
        error: read.error,
        outcome: read.outcome === "unknown" ? "unavailable" : "failed",
      };
    }
    // Event times are already ISO strings from the provider; the row shape is
    // flat so the card can render it without nested components.
    return {
      ok: true,
      rows: read.events.map((event) => ({
        summary: event.summary,
        start: event.start,
        end: event.end,
        id: event.id,
      })),
      asOf: new Date().toISOString(),
    };
  };
}
