import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The row must ask about cards with the server's answer in hand.
 *
 * `messageHasInlineControls` decides whether a card owns the taps that land inside it.
 * It reads the same `/me` answer the card renderer does, but only if the caller passes
 * it: called with no policy it falls back to the build variable, which is unset in a
 * normal build. A card would then be drawn while the row still treated the message as
 * plain text, so double-tapping a field liked the message instead of focusing it.
 *
 * This is a structural assertion, like the dependency-array test beside it: mounting
 * the row drags in Expo native modules, and the contract being checked is exactly
 * "does this call receive the server's answer".
 */
const source = readFileSync(
  path.resolve(import.meta.dirname, "../components/thread/message-row.tsx"),
  "utf8",
);

describe("the row's card-tap decision", () => {
  it("receives the server's card answer", () => {
    const calls = [...source.matchAll(/messageHasInlineControls\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) {
      expect(args).toContain("a2uiEnabled");
    }
  });
});
