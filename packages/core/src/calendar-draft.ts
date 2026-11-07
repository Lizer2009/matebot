import type { CalendarDraftFields, CalendarEvent } from "./calendar-event.js";
import { normalizeCalendarFields, validateCalendarEvent } from "./calendar-event.js";

/**
 * Reading the confirmed calendar draft as either one event or a batch.
 *
 * The surface collects one event. A batch is a separate, explicit shape: slots
 * may carry an `events` list the model filled from what the user asked for, and
 * each item is validated with the same rules as a single event. A batch never
 * arises by fanning out one request — it exists only because the list is there.
 */
export type ConfirmedCalendarDraft =
  | { kind: "single"; event: CalendarEvent }
  | {
      kind: "batch";
      events: Array<{ event: CalendarEvent; label: string }>;
    }
  | { kind: "invalid"; error: string; index?: number };

function itemFields(value: unknown): CalendarDraftFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Each item goes through the same alias normalization a single draft does.
  return normalizeCalendarFields(value as Record<string, unknown>);
}

export function readConfirmedCalendarDraft(slots: Record<string, unknown>): ConfirmedCalendarDraft {
  const list = slots.events;
  if (Array.isArray(list) && list.length > 0) {
    const events: Array<{ event: CalendarEvent; label: string }> = [];
    for (const [index, entry] of list.entries()) {
      const fields = itemFields(entry);
      if (!fields) return { kind: "invalid", error: "invalid_item", index };
      const validated = validateCalendarEvent(fields);
      if (!validated.ok) return { kind: "invalid", error: validated.error, index };
      events.push({ event: validated.event, label: validated.event.name });
    }
    return { kind: "batch", events };
  }

  const validated = validateCalendarEvent(normalizeCalendarFields(slots));
  return validated.ok
    ? { kind: "single", event: validated.event }
    : { kind: "invalid", error: validated.error };
}
