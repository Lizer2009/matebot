import type { BatchItem, CalendarEvent } from "@matebot/core";
import { emailDeliveryOutcome, summarizeBatch } from "@matebot/core";
import type { CalendarCreateResult, InteractionCalendarSender } from "./interaction-calendar.js";
import { createCalendarEvent } from "./interaction-calendar.js";

/**
 * Creating several events when the user asked for several.
 *
 * Spec §5.4.2 requires a partial outcome to be visible: if two of three were
 * created, the card must say so rather than "done". This runs each item with its
 * own idempotency key derived from the batch key and the item index, so a retry
 * of one item cannot create a duplicate of another, and it stops at nothing:
 * every item is attempted, because a failure on the first should not silently
 * drop the rest of what the user asked for.
 */

export type BatchCreateInput = {
  events: Array<{ event: CalendarEvent; label: string }>;
  /** Prefix for each item's key; the index makes every key distinct. */
  batchKey: string;
  sender: InteractionCalendarSender;
  /** The single-item create, injectable so a caller can test the batch itself. */
  create?: (
    draft: { event: CalendarEvent; idempotencyKey: string },
    sender: InteractionCalendarSender,
  ) => Promise<CalendarCreateResult>;
};

export type BatchCreateOutcome = {
  items: BatchItem[];
  summary: ReturnType<typeof summarizeBatch>;
  /** Provider ids by label, for the rows the card shows. */
  created: Array<{ label: string; eventId: string }>;
  /** True when every item succeeded; the caller may report plain success. */
  complete: boolean;
  /** True when at least one item is UNKNOWN, so reconcile is needed. */
  hasUnknown: boolean;
};

export async function createCalendarBatch(input: BatchCreateInput): Promise<BatchCreateOutcome> {
  const items: BatchItem[] = [];
  const created: Array<{ label: string; eventId: string }> = [];

  for (const [index, entry] of input.events.entries()) {
    const create = input.create ?? createCalendarEvent;
    const result: CalendarCreateResult = await create(
      {
        event: entry.event,
        idempotencyKey: `${input.batchKey}:${index}`,
      },
      input.sender,
    ).catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error && error.message ? error.message : "Could not create the event",
      // A throw means the provider may still have created it.
      outcome: "unknown" as const,
    }));

    if (result.ok) {
      items.push({ label: entry.label, state: "succeeded" });
      created.push({ label: entry.label, eventId: result.eventId });
      continue;
    }
    // One classifier for both domains, so a timeout in a batch is UNKNOWN here
    // exactly as it is on the single-send path.
    items.push({
      label: entry.label,
      state: emailDeliveryOutcome(result) === "unknown" ? "unknown" : "failed",
      error: result.error,
    });
  }

  const summary = summarizeBatch(items);
  return {
    items,
    summary,
    created,
    complete: summary.complete,
    hasUnknown: items.some((item) => item.state === "unknown"),
  };
}
