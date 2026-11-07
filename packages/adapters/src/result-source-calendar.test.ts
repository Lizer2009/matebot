import { describe, expect, it } from "vitest";
import { calendarResultReader } from "./result-source-calendar.js";
import { resolveSourceBackedRows } from "./run-tools-result-source.js";

/**
 * The calendar QUERY path: a read that produces a result card.
 *
 * `calendar-events` was a registered source with no reader, so a query could
 * never return anything. These drive the production readers with a connector
 * double in place of the provider; the double speaks the provider's own envelope
 * so the shape, not just the call, is checked. Nothing here reaches the network,
 * and nothing here is a live provider result.
 */

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

function doubleConnector(
  payload: unknown,
  options: { error?: string; emitNothing?: boolean } = {},
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    connector: {
      async *execute(request: { tool: string; args: Record<string, unknown> }) {
        calls.push({ tool: request.tool, args: request.args });
        if (options.emitNothing) return;
        if (options.error) {
          yield { type: "error" as const, message: options.error };
          return;
        }
        yield { type: "result" as const, data: payload };
      },
    },
  };
}

const providerEnvelope = {
  data: {
    items: [
      {
        id: "evt-1",
        summary: "Standup",
        start: { dateTime: "2026-11-09T09:00:00+08:00" },
        end: { dateTime: "2026-11-09T09:15:00+08:00" },
      },
      {
        id: "evt-2",
        summary: "Review",
        start: { dateTime: "2026-11-10T14:00:00+08:00" },
        end: { dateTime: "2026-11-10T15:00:00+08:00" },
      },
    ],
  },
};

describe("calendar result reader", () => {
  it("is only offered when the run has a calendar connection", () => {
    const { connector } = doubleConnector(providerEnvelope);
    expect(calendarResultReader({ connector, context, connectionId: null })).toBeUndefined();
  });

  it("reads the provider window and returns flat rows", async () => {
    const { calls, connector } = doubleConnector(providerEnvelope);
    const reader = calendarResultReader({ connector, context, connectionId: "conn-1" });
    const read = await reader!({
      window: { from: "2026-11-09", to: "2026-11-16" },
      connectionId: "conn-1",
      timezone: "Asia/Shanghai",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.rows).toEqual([
      {
        summary: "Standup",
        start: "2026-11-09T09:00:00+08:00",
        end: "2026-11-09T09:15:00+08:00",
        id: "evt-1",
      },
      {
        summary: "Review",
        start: "2026-11-10T14:00:00+08:00",
        end: "2026-11-10T15:00:00+08:00",
        id: "evt-2",
      },
    ]);
    // The provider call carries the window and the zone it was asked for.
    expect(calls[0]?.args).toMatchObject({
      start_datetime: "2026-11-09",
      end_datetime: "2026-11-16",
      timezone: "Asia/Shanghai",
    });
  });

  it("reports a provider error instead of an empty week", async () => {
    const { connector } = doubleConnector(undefined, { error: "calendar unavailable" });
    const reader = calendarResultReader({ connector, context, connectionId: "conn-1" });
    const read = await reader!({
      window: { from: "2026-11-09", to: "2026-11-16" },
      connectionId: "conn-1",
      timezone: "Asia/Shanghai",
    });
    expect(read).toEqual({ ok: false, error: "calendar unavailable", outcome: "failed" });
  });

  it("treats a connector that returns nothing as unavailable, not as empty", async () => {
    const { connector } = doubleConnector(undefined, { emitNothing: true });
    const reader = calendarResultReader({ connector, context, connectionId: "conn-1" });
    const read = await reader!({
      window: { from: "2026-11-09", to: "2026-11-16" },
      connectionId: "conn-1",
      timezone: "Asia/Shanghai",
    });
    expect(read).toEqual({
      ok: false,
      error: "Could not read the calendar",
      outcome: "unavailable",
    });
  });
});

describe("present_result source path", () => {
  it("reads through the registered source and labels the card as sourced", async () => {
    const { connector, calls } = doubleConnector(providerEnvelope);
    const resolved = await resolveSourceBackedRows(
      { sourceId: "calendar-events", from: "2026-11-09", to: "2026-11-16" },
      {
        connectionFor: async () => "conn-1",
        read: calendarResultReader({ connector, context, connectionId: "conn-1" }),
      },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.rows).toHaveLength(2);
    expect(resolved.provenance).toMatchObject({
      source: "Calendar",
      attribution: "source",
      window: { from: "2026-11-09", to: "2026-11-16" },
    });
    expect(calls).toHaveLength(1);
  });

  it("computes the requested aggregation over the rows it read", async () => {
    const { connector } = doubleConnector({
      data: {
        items: [
          {
            id: "a",
            summary: "Standup",
            start: "2026-11-09T09:00:00Z",
            end: "2026-11-09T09:15:00Z",
          },
          {
            id: "b",
            summary: "Standup",
            start: "2026-11-10T09:00:00Z",
            end: "2026-11-10T09:15:00Z",
          },
          {
            id: "c",
            summary: "Review",
            start: "2026-11-11T14:00:00Z",
            end: "2026-11-11T15:00:00Z",
          },
        ],
      },
    });
    const resolved = await resolveSourceBackedRows(
      {
        sourceId: "calendar-events",
        from: "2026-11-09",
        to: "2026-11-16",
        groupBy: "summary",
        metrics: [{ key: "events", op: "count" }],
      },
      {
        connectionFor: async () => "conn-1",
        read: calendarResultReader({ connector, context, connectionId: "conn-1" }),
      },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Counted by the server from rows it read, in first-seen order.
    expect(resolved.rows).toEqual([
      { summary: "Standup", events: 2 },
      { summary: "Review", events: 1 },
    ]);
    expect(resolved.columns?.map((column) => column.key)).toEqual(["summary", "events"]);
  });

  it("refuses an aggregation over a column the read did not return", async () => {
    const { connector } = doubleConnector(providerEnvelope);
    const resolved = await resolveSourceBackedRows(
      {
        sourceId: "calendar-events",
        from: "2026-11-09",
        to: "2026-11-16",
        metrics: [{ key: "total", op: "sum", of: "duration" }],
      },
      {
        connectionFor: async () => "conn-1",
        read: calendarResultReader({ connector, context, connectionId: "conn-1" }),
      },
    );
    expect(resolved).toEqual({ ok: false, error: "unknown_column" });
  });

  it("refuses without a calendar connection rather than reading anonymously", async () => {
    const resolved = await resolveSourceBackedRows(
      { sourceId: "calendar-events", from: "2026-11-09", to: "2026-11-16" },
      { connectionFor: async () => null },
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe("needs_connection");
  });
});
