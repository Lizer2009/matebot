import { describe, expect, it } from "vitest";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";

describe("isA2uiFeatureEnabled", () => {
  it("defaults off", () => {
    expect(isA2uiFeatureEnabled({})).toBe(false);
    expect(isA2uiFeatureEnabled({ FEATURE_A2UI: "" })).toBe(false);
    expect(isA2uiFeatureEnabled({ FEATURE_A2UI: "off" })).toBe(false);
  });

  it("enables for 1/true/on", () => {
    expect(isA2uiFeatureEnabled({ FEATURE_A2UI: "1" })).toBe(true);
    expect(isA2uiFeatureEnabled({ FEATURE_A2UI: "true" })).toBe(true);
    expect(isA2uiFeatureEnabled({ FEATURE_A2UI: "ON" })).toBe(true);
  });
});
