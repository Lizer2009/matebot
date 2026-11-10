import { describe, expect, it } from "vitest";
import { AI_PRIVACY_PATH } from "./ai-consent.js";
import { integrationPagePath, onMarketingSite, SUBMIT_PLUGIN_PATH } from "./domain.js";

/**
 * Links the product sends people to are built from a resolved origin, never a baked-in host.
 *
 * A shipped APK carried `https://rakazo.com/privacy/` on its paywall and opened
 * `https://rakazo.com/plugins/submit/` in the phone's browser, because the host was a constant
 * in this package. The host belongs to the deployment, so these are paths and the caller
 * supplies the origin — the same `MATEBOT_MARKETING_URL` the marketing site itself builds from.
 */
describe("product links are paths, not hosts", () => {
  it("exposes a path for each page that lives on the marketing site", () => {
    expect(SUBMIT_PLUGIN_PATH).toBe("/plugins/submit/");
    expect(AI_PRIVACY_PATH).toBe("/privacy/");
    expect(integrationPagePath("acme-tickets")).toBe("/integrations/acme-tickets/");
  });

  it("composes a path onto whatever origin the deployment resolved", () => {
    expect(onMarketingSite("https://test.matebot.dev", SUBMIT_PLUGIN_PATH)).toBe(
      "https://test.matebot.dev/plugins/submit/",
    );
    // A trailing slash on the origin must not double up.
    expect(onMarketingSite("https://matebot.dev/", AI_PRIVACY_PATH)).toBe(
      "https://matebot.dev/privacy/",
    );
    // A path given without a leading slash still joins correctly.
    expect(onMarketingSite("https://example.test", "terms/")).toBe("https://example.test/terms/");
  });

  it("keeps the old host out of every link the product builds", () => {
    // The regression this exists to prevent: a host baked into the contract, shipped to phones.
    const built = [
      onMarketingSite("https://test.matebot.dev", SUBMIT_PLUGIN_PATH),
      onMarketingSite("https://test.matebot.dev", AI_PRIVACY_PATH),
      onMarketingSite("https://test.matebot.dev", integrationPagePath("acme")),
    ];
    for (const url of built) {
      expect(url).not.toContain("matebot.com");
      expect(url.startsWith("https://")).toBe(true);
    }
  });
});
