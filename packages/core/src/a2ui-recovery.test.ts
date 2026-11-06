import type { A2uiSurfaceBlock, MessageBlock } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import {
  mergeA2uiMessageBlocks,
  overlayAuthoritativeA2uiBlocks,
  placeA2uiSurfaceBlock,
  preferA2uiSurfaceBlock,
} from "./a2ui-recovery.js";

function surface(overrides: Partial<A2uiSurfaceBlock> = {}): A2uiSurfaceBlock {
  return {
    kind: "a2ui_surface",
    interactionId: "ix-1",
    surfaceId: "surf-1",
    protocolFamily: "v0_9",
    draftVersion: 2,
    confirmedVersion: 2,
    intent: "email.compose",
    title: "Send email",
    ...overrides,
  };
}

describe("preferA2uiSurfaceBlock", () => {
  it("keeps the current block when an older surface event arrives", () => {
    const current = surface({ draftVersion: 3, confirmedVersion: undefined });
    const incoming = surface({ draftVersion: 2, confirmedVersion: 2, title: "Old" });
    expect(preferA2uiSurfaceBlock(current, incoming)).toBe(current);
  });

  it("replaces a newer draft wholesale so a field edit clears confirmation", () => {
    const current = surface({ draftVersion: 2, confirmedVersion: 2 });
    const incoming = surface({ draftVersion: 3, confirmedVersion: undefined, title: "Edited" });
    expect(preferA2uiSurfaceBlock(current, incoming)).toEqual(
      surface({ draftVersion: 3, confirmedVersion: undefined, title: "Edited" }),
    );
  });

  it("keeps confirmation when the same version is replayed without one", () => {
    const current = surface();
    const incoming = surface({ confirmedVersion: undefined, summary: "Edited" });
    expect(preferA2uiSurfaceBlock(current, incoming)).toMatchObject({
      draftVersion: 2,
      confirmedVersion: 2,
      summary: "Edited",
    });
  });

  it("keeps incoming capability at the same draftVersion when set", () => {
    const current = surface({ capability: "not_connected" });
    const incoming = surface({ capability: "ready", summary: "Bound" });
    expect(preferA2uiSurfaceBlock(current, incoming).capability).toBe("ready");
  });

  it("keeps the mailbox stamp when a newer field edit omits capability", () => {
    const current = surface({ draftVersion: 2, capability: "not_connected" });
    const incoming = surface({ draftVersion: 3, confirmedVersion: undefined, title: "Edited" });
    expect(preferA2uiSurfaceBlock(current, incoming)).toMatchObject({
      draftVersion: 3,
      title: "Edited",
      capability: "not_connected",
    });
  });
});

describe("mergeA2uiMessageBlocks", () => {
  it("does not let an older message update drop a newer surface", () => {
    const current: MessageBlock[] = [surface({ draftVersion: 4, confirmedVersion: undefined })];
    const incoming: MessageBlock[] = [
      { kind: "text", text: "Updated" },
      surface({ draftVersion: 2, confirmedVersion: 2 }),
    ];
    expect(mergeA2uiMessageBlocks(current, incoming)).toEqual([
      { kind: "text", text: "Updated" },
      surface({ draftVersion: 4, confirmedVersion: undefined }),
    ]);
  });
});

describe("placeA2uiSurfaceBlock", () => {
  it("ignores an older surface update on an existing message", () => {
    const messages = [
      {
        id: "m1",
        blocks: [surface({ draftVersion: 3, confirmedVersion: undefined, title: "New" })],
      },
    ];
    const placed = placeA2uiSurfaceBlock(
      messages,
      surface({ draftVersion: 2, confirmedVersion: 2, title: "Old" }),
      "m1",
    );
    expect(placed.placed).toBe(true);
    expect(placed.messages[0]?.blocks[0]).toMatchObject({ draftVersion: 3, title: "New" });
  });
});

describe("overlayAuthoritativeA2uiBlocks", () => {
  it("raises the draft to the interaction row and clears a stale confirmation", () => {
    const messages = [
      {
        id: "m1",
        blocks: [
          surface({ draftVersion: 2, confirmedVersion: 2 }),
          { kind: "text" as const, text: "Hi" },
        ],
      },
    ];
    const overlaid = overlayAuthoritativeA2uiBlocks(messages, [
      {
        interactionId: "ix-1",
        surfaceId: "surf-1",
        draftVersion: 3,
        confirmedVersion: 2,
        intent: "email.compose",
        title: "Send email",
      },
    ]);
    expect(overlaid[0]?.blocks[0]).toMatchObject({
      draftVersion: 3,
      intent: "email.compose",
    });
    expect(overlaid[0]?.blocks[0]).not.toHaveProperty("confirmedVersion");
    expect(overlaid[0]?.blocks[1]).toEqual({ kind: "text", text: "Hi" });
  });

  it("records confirmation when it matches the authoritative draft", () => {
    const messages = [
      { id: "m1", blocks: [surface({ draftVersion: 2, confirmedVersion: undefined })] },
    ];
    const overlaid = overlayAuthoritativeA2uiBlocks(messages, [
      {
        interactionId: "ix-1",
        surfaceId: "surf-1",
        draftVersion: 2,
        confirmedVersion: 2,
      },
    ]);
    expect(overlaid[0]?.blocks[0]).toMatchObject({ draftVersion: 2, confirmedVersion: 2 });
  });

  it("leaves messages alone when no surface block is present", () => {
    const messages = [{ id: "m1", blocks: [{ kind: "text" as const, text: "Hi" }] }];
    expect(
      overlayAuthoritativeA2uiBlocks(messages, [
        { interactionId: "ix-1", surfaceId: "surf-1", draftVersion: 2, confirmedVersion: 2 },
      ]),
    ).toEqual(messages);
  });
});
