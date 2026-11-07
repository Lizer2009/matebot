import { TimeZoneSchema } from "@matebot/contracts";

/**
 * Calendar event validation and normalization.
 *
 * This is the calendar domain's own logic, deliberately kept out of the generic
 * field form: a start/end relationship, a real timezone, and the all-day rule
 * that turns a whole day into local midnights. The shared lifecycle, action
 * bridge, and revision writer still do everything else, so calendar is a real
 * second domain rather than a copy of the email templates.
 */

/** The spec's default when the user does not name a zone. */
export const CALENDAR_DEFAULT_TIMEZONE = "Asia/Shanghai" as const;

/** The canonical draft slots a calendar surface edits. */
export type CalendarDraftFields = {
  name?: unknown;
  start?: unknown;
  end?: unknown;
  timezone?: unknown;
  allDay?: unknown;
};

export type CalendarEvent = {
  name: string;
  /** ISO 8601 with an offset, so the instant is unambiguous. */
  start: string;
  end: string;
  timezone: string;
  allDay: boolean;
};

export type CalendarValidationError =
  | "missing_name"
  | "invalid_date"
  | "invalid_timezone"
  | "end_before_start";

export type CalendarValidation =
  | { ok: true; event: CalendarEvent }
  | { ok: false; error: CalendarValidationError };

/** Loose names a model or a user may use for the same slot. */
const FIELD_ALIASES: Record<string, keyof CalendarDraftFields> = {
  title: "name",
  summary: "name",
  begins: "start",
  starts: "start",
  startTime: "start",
  ends: "end",
  endTime: "end",
  tz: "timezone",
  zone: "timezone",
  wholeDay: "allDay",
  isAllDay: "allDay",
};

/** Map loose field names onto the canonical slots, keeping canonical ones. */
export function normalizeCalendarFields(input: Record<string, unknown>): CalendarDraftFields {
  const out: CalendarDraftFields = {};
  for (const [key, value] of Object.entries(input)) {
    const canonical = (FIELD_ALIASES[key] ?? key) as keyof CalendarDraftFields;
    const known: (keyof CalendarDraftFields)[] = ["name", "start", "end", "timezone", "allDay"];
    if (!known.includes(canonical)) continue;
    // A canonical name always wins over an alias for the same slot.
    if (out[canonical] === undefined || canonical === key) out[canonical] = value;
  }
  return out;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseInstant(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The local wall-clock parts of an instant in a given zone, so an all-day event
 * can be snapped to that zone's midnight rather than UTC's.
 */
function zonedParts(instant: number, timezone: string) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone's offset from UTC at a given instant, in minutes. */
function zoneOffsetMinutes(instant: number, timezone: string): number {
  const p = zonedParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - instant) / 60_000);
}

/** A local midnight in the given zone, expressed as an ISO string with its offset. */
function localMidnightIso(year: number, month: number, day: number, timezone: string): string {
  // Guess UTC midnight, then correct by the zone offset at that instant.
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstOffset = zoneOffsetMinutes(guess, timezone);
  let instant = guess - firstOffset * 60_000;
  // One correction pass handles zones whose offset differs across the guess.
  const secondOffset = zoneOffsetMinutes(instant, timezone);
  if (secondOffset !== firstOffset) instant = guess - secondOffset * 60_000;
  const offset = zoneOffsetMinutes(instant, timezone);
  const local = new Date(instant + offset * 60_000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/**
 * Validate and normalize a calendar draft.
 *
 * All-day events snap to local midnights so the span is exact: start at the
 * midnight of the first selected day, end at the midnight after the last
 * selected day. Timed events keep their instants and must be strictly ordered.
 */
export function validateCalendarEvent(input: CalendarDraftFields): CalendarValidation {
  const name = text(input.name);
  if (!name) return { ok: false, error: "missing_name" };

  const zoneInput = text(input.timezone);
  const timezone = zoneInput || CALENDAR_DEFAULT_TIMEZONE;
  if (!TimeZoneSchema.safeParse(timezone).success) {
    return { ok: false, error: "invalid_timezone" };
  }

  const startText = text(input.start);
  const endText = text(input.end);
  const startInstant = parseInstant(startText);
  if (startInstant === undefined) return { ok: false, error: "invalid_date" };
  const endInstant = parseInstant(endText);
  if (endInstant === undefined) return { ok: false, error: "invalid_date" };

  const allDay = input.allDay === true || input.allDay === "true";

  if (allDay) {
    const from = zonedParts(startInstant, timezone);
    const to = zonedParts(endInstant, timezone);
    if (endInstant < startInstant) return { ok: false, error: "end_before_start" };
    const start = localMidnightIso(from.year, from.month, from.day, timezone);
    // A same-day all-day selection still covers one whole day.
    const lastDay = new Date(Date.UTC(to.year, to.month - 1, to.day));
    const nextDay = new Date(lastDay.getTime() + 86_400_000);
    const end = localMidnightIso(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      timezone,
    );
    return { ok: true, event: { name, start, end, timezone, allDay: true } };
  }

  if (endInstant <= startInstant) return { ok: false, error: "end_before_start" };

  return {
    ok: true,
    event: { name, start: startText, end: endText, timezone, allDay: false },
  };
}

/** Which required slots are still missing, so the surface can ask for them. */
export function calendarClarification(input: CalendarDraftFields): { missing: string[] } {
  const missing: string[] = [];
  if (!text(input.name)) missing.push("name");
  if (!text(input.start)) missing.push("start");
  if (!text(input.end)) missing.push("end");
  return { missing };
}
