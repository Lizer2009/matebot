import { a2uiSurfaceDocumentRef, parseA2uiSurfaceDocumentRef } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { interactionSendAllowed } from "./interactions.js";

describe("interactionSendAllowed", () => {
  it("requires confirmedVersion to equal draftVersion", () => {
    expect(interactionSendAllowed({ draftVersion: 3, confirmedVersion: 3 })).toBe(true);
    expect(interactionSendAllowed({ draftVersion: 3, confirmedVersion: 2 })).toBe(false);
    expect(interactionSendAllowed({ draftVersion: 1, confirmedVersion: null })).toBe(false);
  });
});

describe("documentRef helpers (contracts re-export path)", () => {
  it("builds refs the db module can parse", () => {
    const ref = a2uiSurfaceDocumentRef({ interactionId: "ix-1", surfaceId: "s-1" });
    expect(parseA2uiSurfaceDocumentRef(ref)).toEqual({
      interactionId: "ix-1",
      surfaceId: "s-1",
    });
  });
});
