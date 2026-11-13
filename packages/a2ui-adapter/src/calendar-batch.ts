/**
 * The event list a calendar draft carries, in whichever shape the model sent it.
 *
 * A tool argument arrives as JSON text, so a model holding eight events sends one
 * string far more often than an array. The compiler only read arrays: the card drew a
 * single-event form with an empty Starts/Ends and no list at all, so the reader saw one
 * blank event instead of the itinerary. Both shapes are the same batch.
 *
 * Only a structurally usable batch counts: every item needs a title and a start. A list
 * that is missing those is not a draft the card can show, and treating it as one would
 * hide the very fields that still need a value.
 */
export function calendarBatchItems(value: unknown): Array<Record<string, unknown>> | undefined {
  const parsed: unknown =
    typeof value === "string"
      ? (() => {
          if (value.trim() === "") return undefined;
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const items: Array<Record<string, unknown>> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    const title = [record.name, record.title, record.summary].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
    );
    const start = record.start;
    if (!title || typeof start !== "string" || start.trim() === "") return undefined;
    items.push(record);
  }
  return items;
}

/** The single-event controls a batch does not have. */
export const CALENDAR_SINGLE_EVENT_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "start",
  "end",
  "timezone",
  "allDay",
]);
