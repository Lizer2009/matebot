import { describe, expect, it } from "vitest";
import { interactionCardKey } from "./interaction-card-key.js";

describe("interaction card key", () => {
  it("is stable for the same thread and intent", () => {
    expect(interactionCardKey("thread-1", "email.compose")).toBe(
      interactionCardKey("thread-1", "email.compose"),
    );
  });

  it("is a 64-character lowercase hex digest", () => {
    expect(interactionCardKey("thread-1", "email.compose")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates one thread's two intents", () => {
    expect(interactionCardKey("thread-1", "email.compose")).not.toBe(
      interactionCardKey("thread-1", "calendar.create"),
    );
  });

  it("separates one intent across two threads", () => {
    expect(interactionCardKey("thread-1", "email.compose")).not.toBe(
      interactionCardKey("thread-2", "email.compose"),
    );
  });

  // Without the NUL separator, ("a","bc") and ("ab","c") hash the same input and
  // two unrelated cards would share one identity.
  it("cannot be shifted across the thread/intent boundary", () => {
    expect(interactionCardKey("a", "bc")).not.toBe(interactionCardKey("ab", "c"));
  });

  it("refuses an empty thread id", () => {
    expect(() => interactionCardKey("", "email.compose")).toThrow(TypeError);
  });

  it("refuses an empty intent", () => {
    expect(() => interactionCardKey("thread-1", "")).toThrow(TypeError);
  });
});
