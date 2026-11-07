import { describe, expect, it } from "vitest";
import {
  A2UI_METRICS,
  isA2uiFirstFeedback,
  percentile95,
  timingFields,
  timingReport,
  timingSample,
} from "./a2ui-timing.js";

/**
 * The measurement the spec asks for, defined so it can be reproduced.
 *
 * The point worth testing hardest is that a surface counts as first feedback:
 * the existing run metric does not treat `a2ui_surface` as a response, so without
 * this rule an A2UI-only turn reports no first feedback and its p95 vanishes.
 */

describe("isA2uiFirstFeedback", () => {
  it("counts a bot message that carries a surface", () => {
    expect(
      isA2uiFirstFeedback("thread.message.created", {
        role: "bot",
        blocks: [{ kind: "a2ui_surface", interactionId: "ix-1", surfaceId: "s-1" }],
      }),
    ).toBe(true);
  });

  it("counts a surface that arrives next to text", () => {
    expect(
      isA2uiFirstFeedback("thread.message.created", {
        role: "bot",
        blocks: [{ kind: "text", text: "Here it is." }, { kind: "a2ui_surface" }],
      }),
    ).toBe(true);
  });

  it("does not count a user message", () => {
    expect(
      isA2uiFirstFeedback("thread.message.created", {
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).toBe(false);
  });

  it("does not count an empty text block", () => {
    expect(
      isA2uiFirstFeedback("thread.message.created", {
        role: "bot",
        blocks: [{ kind: "text", text: "   " }],
      }),
    ).toBe(false);
  });
});

describe("timingSample", () => {
  it("measures from the named origin and never goes negative", () => {
    const origin = new Date("2026-11-06T00:00:00.000Z");
    const sample = timingSample({
      metric: "surface-visible",
      origin,
      at: new Date("2026-11-06T00:00:00.420Z"),
      originLabel: "user-message",
    });
    expect(sample).toEqual({ metric: "surface-visible", ms: 420, origin: "user-message" });
    expect(
      timingSample({ metric: "plan-ready", origin: 100, at: 90, originLabel: "run-created" }).ms,
    ).toBe(0);
  });

  it("names every field so a metric is never confused with a run field", () => {
    expect(timingFields({ metric: "reconciled", ms: 12, origin: "run-created" })).toEqual({
      "a2ui.metric": "reconciled",
      "a2ui.origin": "run-created",
      "a2ui.ms": 12,
    });
  });
});

describe("percentile95", () => {
  it("returns an observed value, not an interpolation", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    // 19 of 20 values are at or below this one.
    expect(percentile95(values)).toBe(19);
  });

  it("handles a single sample and an empty set", () => {
    expect(percentile95([42])).toBe(42);
    expect(percentile95([])).toBeNull();
  });

  it("summarises a run of samples", () => {
    expect(timingReport([100, 200, 300, 400])).toMatchObject({ samples: 4, p95: 400, max: 400 });
    expect(timingReport([])).toEqual({ samples: 0, p50: null, p95: null, max: null });
  });
});

describe("A2UI_METRICS", () => {
  it("covers the seven moments the spec names", () => {
    expect([...A2UI_METRICS]).toEqual([
      "user-submit",
      "first-feedback",
      "plan-ready",
      "surface-visible",
      "action-confirmed",
      "provider-result",
      "reconciled",
    ]);
  });
});
