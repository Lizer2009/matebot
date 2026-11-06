import { describe, expect, it, vi } from "vitest";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

import type { MobileSnapshot } from "./api";
import { applyMobileThreadEvent, mergeMobileSnapshot } from "./api";

function snapshot(draftVersion: number): MobileSnapshot {
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
        blocks: [
          {
            kind: "a2ui_surface",
            interactionId: "ix-1",
            surfaceId: "surf-1",
            protocolFamily: "v0_9",
            draftVersion,
            title: "Current",
          },
        ],
      },
    ],
  };
}

describe("mobile A2UI recovery", () => {
  it("shows a surface event and ignores an older draft", () => {
    const created = applyMobileThreadEvent(snapshot(1), {
      id: "event-5",
      seq: 5,
      type: "thread.surface.updated",
      payload: {
        interactionId: "ix-1",
        surfaceId: "surf-1",
        protocolFamily: "v0_9",
        draftVersion: 2,
        title: "Edited",
        messageId: "m1",
      },
    });
    expect(created?.messages[0]?.blocks[0]).toMatchObject({ draftVersion: 2, title: "Edited" });
    const replayed = applyMobileThreadEvent(created, {
      id: "event-6",
      seq: 6,
      type: "thread.surface.updated",
      payload: {
        interactionId: "ix-1",
        surfaceId: "surf-1",
        protocolFamily: "v0_9",
        draftVersion: 1,
        title: "Old",
        messageId: "m1",
      },
    });
    expect(replayed?.messages[0]?.blocks[0]).toMatchObject({ draftVersion: 2, title: "Edited" });
  });

  it("keeps the newer surface when a snapshot is merged", () => {
    const previous = snapshot(3);
    const incoming = snapshot(2);
    const merged = mergeMobileSnapshot({ ...previous, cursor: 5 }, { ...incoming, cursor: 5 });
    expect(merged.messages[0]?.blocks[0]).toMatchObject({ draftVersion: 3, title: "Current" });
  });
});
