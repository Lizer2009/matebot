import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@matebot/adapter-kit";
import type { CalendarEvent } from "@matebot/core";

/**
 * Creates a calendar event through the user's own connection.
 *
 * The shape deliberately mirrors `deliverInteractionEmail`: one injected sender,
 * a resolved delivery or a classified failure, and no default-constructed client.
 * Tests inject a double; production injects the connector the run already has.
 */

export type CalendarCreateResult =
  | { ok: true; eventId: string }
  | { ok: false; error: string; outcome?: "failed" | "unknown" };

export type CalendarReadResult =
  | { ok: true; events: Array<{ id: string; summary: string; start: string; end: string }> }
  | { ok: false; error: string; outcome?: "failed" | "unknown" };

/** The provider tool the create path uses. Vendor names stay in adapters. */
export const INTERACTION_CALENDAR_CREATE_TOOL = "GOOGLECALENDAR_CREATE_EVENT";
export const INTERACTION_CALENDAR_LIST_TOOL = "GOOGLECALENDAR_EVENTS_LIST";

export type InteractionCalendarSender = {
  kind: "connector";
  context: AdapterContext;
  connector: Pick<ConnectorProvider, "execute">;
  connectionId?: string;
};

export type CalendarDraft = {
  event: CalendarEvent;
  idempotencyKey: string;
};

function eventIdFromUnknown(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const nested = record.data;
  const id =
    record.eventId ??
    record.id ??
    (nested && typeof nested === "object" && !Array.isArray(nested)
      ? ((nested as Record<string, unknown>).eventId ?? (nested as Record<string, unknown>).id)
      : undefined);
  return typeof id === "string" && id.trim() ? id.trim() : fallback;
}

function eventsFromUnknown(value: unknown): CalendarReadResult {
  if (!value || typeof value !== "object") return { ok: true, events: [] };
  const record = value as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : record;
  const items = nested.items ?? nested.events ?? nested.messages;
  if (!Array.isArray(items)) return { ok: true, events: [] };
  const events = items
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      start:
        typeof entry.start === "string"
          ? entry.start
          : typeof (entry.start as { dateTime?: unknown } | undefined)?.dateTime === "string"
            ? String((entry.start as { dateTime: string }).dateTime)
            : "",
      end:
        typeof entry.end === "string"
          ? entry.end
          : typeof (entry.end as { dateTime?: unknown } | undefined)?.dateTime === "string"
            ? String((entry.end as { dateTime: string }).dateTime)
            : "",
    }))
    .filter((entry) => entry.id || entry.summary);
  return { ok: true, events };
}

/**
 * Create one event. A thrown or empty response is UNKNOWN, never a success:
 * the shared runtime reconciles an ambiguous create exactly as it does a send.
 */
export async function createCalendarEvent(
  draft: CalendarDraft,
  sender: InteractionCalendarSender,
): Promise<CalendarCreateResult> {
  let lastError: string | undefined;
  let lastResult: unknown;
  for await (const event of sender.connector.execute(
    {
      tool: INTERACTION_CALENDAR_CREATE_TOOL,
      args: {
        summary: draft.event.name,
        start_datetime: draft.event.start,
        end_datetime: draft.event.end,
        timezone: draft.event.timezone,
        // Never invite anyone unless the draft explicitly names attendees; the
        // Phase 1 capability does not collect them, so this stays false.
        create_meeting_room: false,
        ...(draft.event.allDay ? { all_day: true } : {}),
      },
      executionId: draft.idempotencyKey,
      ...(sender.connectionId ? { connectionId: sender.connectionId } : {}),
      route: { connectorId: "composio", toolName: INTERACTION_CALENDAR_CREATE_TOOL },
    },
    sender.context,
  ) as AsyncIterable<ConnectorEvent>) {
    if (event.type === "error") lastError = event.message;
    if (event.type === "result") lastResult = event.data;
  }
  if (lastError) return { ok: false, error: lastError || "Could not create the event" };
  if (lastResult === undefined) {
    return { ok: false, error: "Could not confirm the event was created", outcome: "unknown" };
  }
  return { ok: true, eventId: eventIdFromUnknown(lastResult, draft.idempotencyKey) };
}

/**
 * Read events in a window. This is the QUERY path: it creates nothing, and the
 * surface it feeds is a result card, not a draft.
 */
export async function readCalendarEvents(
  input: { from: string; to: string; timezone: string; idempotencyKey: string },
  sender: InteractionCalendarSender,
): Promise<CalendarReadResult> {
  let lastError: string | undefined;
  let lastResult: unknown;
  for await (const event of sender.connector.execute(
    {
      tool: INTERACTION_CALENDAR_LIST_TOOL,
      args: {
        start_datetime: input.from,
        end_datetime: input.to,
        timezone: input.timezone,
        single_events: true,
        order_by: "startTime",
      },
      executionId: input.idempotencyKey,
      ...(sender.connectionId ? { connectionId: sender.connectionId } : {}),
      route: { connectorId: "composio", toolName: INTERACTION_CALENDAR_LIST_TOOL },
    },
    sender.context,
  ) as AsyncIterable<ConnectorEvent>) {
    if (event.type === "error") lastError = event.message;
    if (event.type === "result") lastResult = event.data;
  }
  if (lastError) return { ok: false, error: lastError };
  if (lastResult === undefined) {
    return { ok: false, error: "Could not read the calendar", outcome: "unknown" };
  }
  return eventsFromUnknown(lastResult);
}
