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

  /**
   * The deployment's answer decides, not a build variable nothing sets.
   *
   * The production image was built without `VITE_FEATURE_A2UI` and no reader ever set
   * the storage key, so every card was dropped. `/me` now reports the server's own
   * setting; that has to be enough on its own.
   */
  it("follows the server when the build has no flag", () => {
    expect(isA2uiEnabled({ env: {}, storage: null, server: true })).toBe(true);
    // The server is authoritative the other way too: a stale browser key must not
    // draw a card the deployment says it does not serve.
    expect(isA2uiEnabled({ env: {}, storage: null, server: false })).toBe(false);
    expect(
      isA2uiEnabled({
        env: {},
        server: false,
        storage: { getItem: () => "1" } as unknown as Storage,
      }),
    ).toBe(false);
  });

  it("keeps the development override for a build made with it", () => {
    // The browser suite and local development set this deliberately.
    expect(isA2uiEnabled({ env: { VITE_FEATURE_A2UI: "1" }, server: false })).toBe(true);
  });
});
