import { describe, expect, it } from "vitest";
import type { ReplyState } from "./run-context.js";
import { restatesPublishedNarration } from "./run-progress.js";

/**
 * One conclusion should not become six bubbles.
 *
 * The audit saw six consecutive restatements of the same finding, each the tail of
 * a shell command. The check must be conservative in the other direction too: a
 * genuinely different result must always be published, and two runs that reach the
 * same conclusion must both report it.
 */

function reply(midTurnUserTexts: string[]): ReplyState {
  return { midTurnUserTexts } as ReplyState;
}

describe("restatesPublishedNarration", () => {
  it("holds back a note identical to one already posted", () => {
    expect(
      restatesPublishedNarration(
        reply(["12 public repos: 11 forks, 1 empty."]),
        "12 public repos: 11 forks, 1 empty.",
      ),
    ).toBe(true);
  });

  it("holds back the same conclusion when only whitespace and case differ", () => {
    expect(
      restatesPublishedNarration(
        reply(["The conclusion is unchanged."]),
        "the   conclusion is\nunchanged.  ",
      ),
    ).toBe(true);
  });

  it("publishes a note with any new content", () => {
    expect(
      restatesPublishedNarration(reply(["Found three suppliers so far."]), "Checking the fourth."),
    ).toBe(false);
  });

  it("publishes when nothing has been posted yet", () => {
    expect(restatesPublishedNarration(reply([]), "Found three suppliers so far.")).toBe(false);
  });

  it("compares against everything posted this run, not only the last one", () => {
    expect(
      restatesPublishedNarration(
        reply(["First result.", "Second result.", "First result."]),
        "Second result.",
      ),
    ).toBe(true);
  });

  it("never treats an empty note as a restatement", () => {
    expect(restatesPublishedNarration(reply([""]), "")).toBe(false);
  });

  it("does not compare across runs", () => {
    // A second run has its own reply state, so the same conclusion is reported again.
    expect(restatesPublishedNarration(reply([]), "The conclusion is unchanged.")).toBe(false);
  });
});
