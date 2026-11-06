import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-android-apk.yml"),
  "utf8",
);
const easConfig = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../eas.json"), "utf8"),
) as { build: Record<string, { extends?: string; android?: { buildType?: string } }> };

describe("Android APK release workflow", () => {
  it("only runs on demand or from release-mobile, from main with release credentials", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n {2}workflow_call:\n\n/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("cache: pnpm");
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("builds a production-channel APK and never takes the desktop updater's latest release", () => {
    expect(easConfig.build["android-apk"]).toEqual({
      extends: "production",
      android: { buildType: "apk" },
      environment: "production",
    });
    expect(workflow).toContain("--profile android-apk");
    expect(workflow).toContain("--latest=false");
    expect(workflow).not.toContain("gh release delete");
    expect(readFileSync(path.resolve(import.meta.dirname, "../app.config.ts"), "utf8")).toContain(
      '"android-apk"',
    );
  });

  // The marketing site's /api/download?platform=android and docs/mobile-release.md name this asset.
  it("publishes the APK under the documented stable name", () => {
    expect(workflow).toContain("RELEASE_TAG: android");
    expect(workflow).toContain("releases/download/android/matebot.apk");
    expect(workflow).not.toContain("rakazo.apk");
    // The create and replace paths both use the stable name, or the download URL breaks.
    expect(workflow).toContain('gh release create "$RELEASE_TAG" "$RUNNER_TEMP/matebot.apk"');
    expect(workflow).toContain("-f name=matebot.apk");
  });

  // Firebase config is native, so it cannot arrive in an OTA update; its absence must not block the
  // first APK, which docs/mobile-release.md states is supported.
  it("warns instead of failing when Android push is not configured", () => {
    const step = workflow.slice(
      workflow.indexOf("- name: Check the Android push configuration"),
      workflow.indexOf("- name: Build APK on EAS"),
    );
    expect(step).toContain("GOOGLE_SERVICES_JSON");
    expect(step).toContain("::warning::");
    expect(step).not.toContain("exit 1");
  });
});
