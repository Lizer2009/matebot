import { describe, expect, it } from "vitest";
import { readConfirmedCalendarDraft } from "./calendar-draft.js";

/**
 * A confirmed calendar draft is either one event or an explicit list.
 *
 * The rule worth pinning is that a batch only exists because the list is there:
 * nothing fans a single request out into several, and a broken item is refused
 * with its index rather than silently skipped.
 */

const one = {
  name: "Standup",
  start: "2026-11-09T09:00:00+08:00",
  end: "2026-11-09T09:15:00+08:00",
  timezone: "Asia/Shanghai",
};

describe("readConfirmedCalendarDraft", () => {
  it("reads a single event", () => {
    const draft = readConfirmedCalendarDraft(one);
    expect(draft.kind).toBe("single");
    if (draft.kind !== "single") return;
    expect(draft.event.name).toBe("Standup");
  });

  it("reads an explicit list as a batch", () => {
    const draft = readConfirmedCalendarDraft({
      events: [
        one,
        {
          ...one,
          name: "Review",
          start: "2026-11-10T14:00:00+08:00",
          end: "2026-11-10T15:00:00+08:00",
        },
      ],
    });
    expect(draft.kind).toBe("batch");
    if (draft.kind !== "batch") return;
    expect(draft.events.map((entry) => entry.label)).toEqual(["Standup", "Review"]);
  });

  it("names the item that failed and where it was", () => {
    const draft = readConfirmedCalendarDraft({
      events: [one, { ...one, name: "Bad", end: "2026-11-08T09:00:00+08:00" }],
    });
    expect(draft).toEqual({ kind: "invalid", error: "end_before_start", index: 1 });
  });

  it("refuses an item that is not an object", () => {
    const draft = readConfirmedCalendarDraft({ events: ["Standup"] });
    expect(draft).toEqual({ kind: "invalid", error: "invalid_item", index: 0 });
  });

  it("does not invent a batch from a single event", () => {
    const draft = readConfirmedCalendarDraft({ ...one, events: [] });
    expect(draft.kind).toBe("single");
  });

  it("reports a missing name rather than creating an unnamed event", () => {
    const draft = readConfirmedCalendarDraft({ ...one, name: "  " });
    expect(draft).toEqual({ kind: "invalid", error: "missing_name" });
  });
});
