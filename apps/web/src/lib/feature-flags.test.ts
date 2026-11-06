import { describe, expect, it } from "vitest";
import { isA2uiEnabled, isFeatureEnabled } from "./feature-flags";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key() {
      return null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("isA2uiEnabled", () => {
  it("defaults to off", () => {
    expect(isA2uiEnabled({ env: {}, storage: null })).toBe(false);
    expect(isFeatureEnabled("a2ui", { env: {}, storage: null })).toBe(false);
  });

  it("respects VITE_FEATURE_A2UI", () => {
    expect(isA2uiEnabled({ env: { VITE_FEATURE_A2UI: "1" }, storage: null })).toBe(true);
    expect(isA2uiEnabled({ env: { VITE_FEATURE_A2UI: "true" }, storage: null })).toBe(true);
    expect(isA2uiEnabled({ env: { VITE_FEATURE_A2UI: "0" }, storage: null })).toBe(false);
  });

  it("env off wins over storage on", () => {
    const storage = memoryStorage({ "matebot.feature.a2ui": "1" });
    expect(isA2uiEnabled({ env: { VITE_FEATURE_A2UI: "0" }, storage })).toBe(false);
  });

  it("reads storage when env is unset", () => {
    const storage = memoryStorage({ "matebot.feature.a2ui": "1" });
    expect(isA2uiEnabled({ env: {}, storage })).toBe(true);
  });
});
