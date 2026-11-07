import { describe, expect, it } from "vitest";
import { createCalendarBatch } from "./interaction-calendar-batch.js";

/**
 * Partial batches, driven through the real create path with a connector double.
 *
 * The card must be able to say "two of three" instead of "done", and each item
 * needs its own idempotency key so a retry cannot duplicate a sibling.
 */

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

const event = (name: string) => ({
  event: {
    name,
    start: "2026-11-09T09:00:00+08:00",
    end: "2026-11-09T09:30:00+08:00",
    timezone: "Asia/Shanghai",
    allDay: false,
  },
  label: name,
});

function senderWith(
  results: Array<{ ok: true; id: string } | { ok: false; error: string; outcome?: "unknown" }>,
) {
  const calls: Array<{ executionId?: string; args: Record<string, unknown> }> = [];
  let index = 0;
  return {
    calls,
    sender: {
      kind: "connector" as const,
      context,
      connectionId: "conn-1",
      connector: {
        async *execute(request: { args: Record<string, unknown>; executionId?: string }) {
          calls.push({
            ...(request.executionId ? { executionId: request.executionId } : {}),
            args: request.args,
          });
          const next = results[index++];
          if (!next) {
            yield { type: "error" as const, message: "unexpected extra call" };
            return;
          }
          if (!next.ok) {
            yield { type: "error" as const, message: next.error };
            return;
          }
          yield { type: "result" as const, data: { eventId: next.id } };
        },
      },
    },
  };
}

describe("createCalendarBatch", () => {
  it("reports a partial batch instead of claiming success", async () => {
    const { sender } = senderWith([
      { ok: true, id: "evt-1" },
      { ok: false, error: "declined" },
      { ok: true, id: "evt-3" },
    ]);
    const outcome = await createCalendarBatch({
      events: [event("A"), event("B"), event("C")],
      batchKey: "batch-1",
      sender,
    });
    expect(outcome.complete).toBe(false);
    expect(outcome.summary).toMatchObject({ total: 3, succeeded: 2, failed: 1, partial: true });
    expect(outcome.items.map((item) => item.state)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(outcome.created).toEqual([
      { label: "A", eventId: "evt-1" },
      { label: "C", eventId: "evt-3" },
    ]);
  });

  it("gives every item its own idempotency key", async () => {
    const { sender, calls } = senderWith([
      { ok: true, id: "evt-1" },
      { ok: true, id: "evt-2" },
    ]);
    await createCalendarBatch({
      events: [event("A"), event("B")],
      batchKey: "batch-1",
      sender,
    });
    expect(calls.map((call) => call.executionId)).toEqual(["batch-1:0", "batch-1:1"]);
  });

  it("attempts every item even after one fails", async () => {
    const { sender, calls } = senderWith([
      { ok: false, error: "declined" },
      { ok: true, id: "evt-2" },
    ]);
    await createCalendarBatch({
      events: [event("A"), event("B")],
      batchKey: "batch-1",
      sender,
    });
    // A failure on the first must not drop what else the user asked for.
    expect(calls).toHaveLength(2);
  });

  it("keeps an unknown item separate so it can be reconciled", async () => {
    const { sender } = senderWith([{ ok: false, error: "timeout", outcome: "unknown" }]);
    const outcome = await createCalendarBatch({
      events: [event("A")],
      batchKey: "batch-1",
      sender,
    });
    expect(outcome.hasUnknown).toBe(true);
    expect(outcome.summary).toMatchObject({ succeeded: 0, unknown: 1 });
  });

  it("treats a thrown create as unknown, not as a clean failure", async () => {
    const sender = {
      kind: "connector" as const,
      context,
      connectionId: "conn-1",
      connector: {
        execute() {
          // A dropped socket: the provider fails before it reports anything.
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  throw new Error("socket closed");
                },
              };
            },
          };
        },
      },
    };
    const outcome = await createCalendarBatch({
      events: [event("A")],
      batchKey: "batch-1",
      sender,
    });
    expect(outcome.items[0]).toMatchObject({ state: "unknown", error: "socket closed" });
  });
});
