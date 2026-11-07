import { describe, expect, it } from "vitest";
import {
  CALENDAR_DEFAULT_TIMEZONE,
  calendarClarification,
  normalizeCalendarFields,
  validateCalendarEvent,
} from "./calendar-event.js";

/**
 * The calendar domain's validation, which is the part a generic field form
 * cannot do for it: a real start/end relationship, a real timezone, and the
 * all-day rule that makes midnight local rather than UTC.
 */

const base = {
  name: "Team sync",
  start: "2026-11-09T09:00:00+08:00",
  end: "2026-11-09T10:00:00+08:00",
  timezone: CALENDAR_DEFAULT_TIMEZONE,
  allDay: false,
};

describe("validateCalendarEvent", () => {
  it("accepts a well-formed event and keeps the declared zone", () => {
    expect(validateCalendarEvent(base)).toMatchObject({ ok: true });
  });

  it("defaults to Asia/Shanghai when the user did not name a zone", () => {
    expect(CALENDAR_DEFAULT_TIMEZONE).toBe("Asia/Shanghai");
    const result = validateCalendarEvent({ ...base, timezone: undefined });
    expect(result).toMatchObject({ ok: true, event: { timezone: "Asia/Shanghai" } });
  });

  it("honours an explicit timezone over the default", () => {
    const result = validateCalendarEvent({ ...base, timezone: "Europe/Berlin" });
    expect(result).toMatchObject({ ok: true, event: { timezone: "Europe/Berlin" } });
  });

  it("rejects an unknown timezone instead of silently using UTC", () => {
    expect(validateCalendarEvent({ ...base, timezone: "Mars/Olympus" })).toMatchObject({
      ok: false,
      error: "invalid_timezone",
    });
  });

  it("rejects an end before the start", () => {
    expect(validateCalendarEvent({ ...base, end: "2026-11-09T08:00:00+08:00" })).toMatchObject({
      ok: false,
      error: "end_before_start",
    });
  });

  it("rejects an end equal to the start", () => {
    expect(validateCalendarEvent({ ...base, end: base.start })).toMatchObject({
      ok: false,
      error: "end_before_start",
    });
  });

  it("rejects an unparseable date", () => {
    expect(validateCalendarEvent({ ...base, start: "next tuesday" })).toMatchObject({
      ok: false,
      error: "invalid_date",
    });
  });

  it("requires a name", () => {
    expect(validateCalendarEvent({ ...base, name: "   " })).toMatchObject({
      ok: false,
      error: "missing_name",
    });
  });

  // All-day events are whole local days: the start is midnight in the event's
  // own zone, and the end is the following midnight, so the span is exact.
  it("normalizes an all-day event to local midnights", () => {
    const result = validateCalendarEvent({
      name: "Holiday",
      start: "2026-11-09T13:45:00+08:00",
      end: "2026-11-10T09:30:00+08:00",
      timezone: "Asia/Shanghai",
      allDay: true,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.event.start).toBe("2026-11-09T00:00:00+08:00");
    // The end lands on the next local midnight after the selected last day.
    expect(result.event.end).toBe("2026-11-11T00:00:00+08:00");
  });

  it("rejects an all-day event whose end is before its start", () => {
    expect(
      validateCalendarEvent({
        ...base,
        allDay: true,
        start: "2026-11-10T09:00:00+08:00",
        end: "2026-11-09T09:00:00+08:00",
      }),
    ).toMatchObject({ ok: false, error: "end_before_start" });
  });

  it("keeps start and end consistent with the declared zone", () => {
    const result = validateCalendarEvent({
      ...base,
      timezone: "America/New_York",
      start: "2026-11-09T09:00:00-05:00",
      end: "2026-11-09T10:00:00-05:00",
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // The stored instants are zone-correct, so 9am New York is 14:00 UTC.
    expect(new Date(result.event.start).toISOString()).toBe("2026-11-09T14:00:00.000Z");
  });
});

describe("calendarClarification", () => {
  it("asks for a missing name", () => {
    expect(calendarClarification({ ...base, name: "" })).toMatchObject({
      missing: expect.arrayContaining(["name"]),
    });
  });

  it("asks for a missing start", () => {
    expect(calendarClarification({ ...base, start: undefined })).toMatchObject({
      missing: expect.arrayContaining(["start"]),
    });
  });

  it("asks for nothing when the event is complete", () => {
    expect(calendarClarification(base)).toMatchObject({ missing: [] });
  });
});

describe("normalizeCalendarFields", () => {
  it("maps loose field names onto the canonical draft slots", () => {
    expect(
      normalizeCalendarFields({
        title: "Team sync",
        begins: "2026-11-09T09:00:00+08:00",
        ends: "2026-11-09T10:00:00+08:00",
        tz: "Asia/Shanghai",
        wholeDay: true,
      }),
    ).toMatchObject({
      name: "Team sync",
      start: "2026-11-09T09:00:00+08:00",
      end: "2026-11-09T10:00:00+08:00",
      timezone: "Asia/Shanghai",
      allDay: true,
    });
  });

  it("leaves already-canonical names alone", () => {
    expect(normalizeCalendarFields(base)).toMatchObject(base);
  });
});
