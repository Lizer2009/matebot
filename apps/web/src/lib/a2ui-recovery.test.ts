import type { ProductEvent, ThreadSnapshot } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { isThreadSnapshotEvent, mergeThreadSnapshot, reduceThreadSnapshot } from "./thread-events";

function surfaceSnapshot(draftVersion: number): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 4,
    olderCursor: null,
    run: null,
    messages: [
      {
        id: "m1",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        createdAt: "2026-11-06T12:00:00.000Z",
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion,
            ...(draftVersion === 2 ? { confirmedVersion: 2 } : {}),
            title: "Current",
          },
        ],
      },
    ],
  };
}

function surfaceEvent(draftVersion: number, seq: number): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "thread.surface.updated",
    createdAt: "2026-11-06T12:00:01.000Z",
    payload: {
      interactionId: "ix-1",
      surfaceId: "surf-1",
      protocolFamily: "v0_9",
      draftVersion,
      title: "Incoming",
      messageId: "m1",
    },
  };
}

describe("A2UI snapshot recovery", () => {
  it("treats surface events as timeline events", () => {
    expect(isThreadSnapshotEvent(surfaceEvent(2, 5))).toBe(true);
  });

  it("keeps a newer draft when an older surface event is replayed", () => {
    const next = reduceThreadSnapshot(surfaceSnapshot(3), surfaceEvent(2, 5));
    expect(next?.cursor).toBe(5);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({ draftVersion: 3, title: "Current" });
  });

  it("keeps a same-version confirmation when a snapshot omits it", () => {
    const previous = surfaceSnapshot(2);
    const incoming: ThreadSnapshot = {
      ...surfaceSnapshot(2),
      cursor: 4,
      messages: [
        {
          ...previous.messages[0]!,
          blocks: [
            {
              kind: "a2ui_surface",
              interactionId: "ix-1",
              surfaceId: "surf-1",
              protocolFamily: "v0_9",
              draftVersion: 2,
              title: "From snapshot",
            },
          ],
        },
      ],
    };
    const merged = mergeThreadSnapshot(previous, incoming);
    expect(merged.messages[0]?.blocks[0]).toMatchObject({
      draftVersion: 2,
      confirmedVersion: 2,
      title: "From snapshot",
    });
  });
});
