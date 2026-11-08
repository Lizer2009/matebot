import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-android-apk.yml"),
  "utf8",
);
const easConfig = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../eas.json"), "utf8"),
) as { build: Record<string, { extends?: string; android?: { buildType?: string } }> };

const directory = mkdtempSync(path.join(tmpdir(), "apk-workflow-"));

/**
 * Every `run:` block in the workflow, with the indentation YAML would strip.
 *
 * Reading them out of the text keeps this test free of a YAML dependency while still
 * handing `bash -n` the exact script a runner would see.
 */
function runScripts(text: string): string[] {
  const lines = text.split("\n");
  const scripts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(\||>)?\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    const indent = (match[1] ?? "").length;
    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      if ((line.match(/^\s*/)?.[0] ?? "").length <= indent) break;
      body.push(line);
    }
    const dedented = body
      .map((line) =>
        line.trim() === ""
          ? ""
          : line.slice(
              Math.min(
                ...body.filter((l) => l.trim()).map((l) => (l.match(/^\s*/)?.[0] ?? "").length),
              ),
            ),
      )
      .join("\n");
    scripts.push(`${dedented}\n`);
    index = cursor - 1;
  }
  return scripts;
}

describe("Android APK release workflow", () => {
  it("runs on demand, from release-mobile, or from a prerelease tag, never from a branch", () => {
    expect(workflow).toContain("  workflow_dispatch:\n");
    expect(workflow).toContain("  workflow_call:\n");
    // A prerelease tag is the only ref other than main that publishes: a branch alone
    // must not replace the rolling APK.
    // A separate namespace: a desktop `v*` tag must not start an APK build, and this
    // one must not start a desktop or image build.
    expect(workflow).toContain('tags: ["android-pr*"]');
    expect(workflow).not.toContain("v*-pr*");
    const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
    expect(trigger).not.toContain("branches:");
    expect(workflow).toContain(
      "if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/android-pr')",
    );
    expect(workflow).toContain("permissions:\n  contents: read");
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

  // A build from a prerelease tag must not read as a stable build in the rolling
  // release title or notes, and it must say which tag and commit it came from.
  it("labels a prerelease-tag build in the rolling release", () => {
    expect(workflow).toContain('if [[ "$GITHUB_REF" == refs/tags/android-pr* ]]; then');
    expect(workflow).toContain('title="$title from $SOURCE_REF"');
    expect(workflow).toContain("Not a stable build");
    expect(workflow).toContain('--notes "$(notes)"');
    // The stable path still keeps its own wording.
    expect(workflow).toContain("It updates itself over the air.");
  });

  it("keeps the documented download URL and never deletes the rolling release", () => {
    // The site's /api/download?platform=android resolves this tag, so neither may change.
    expect(workflow).toContain("RELEASE_TAG: android");
    expect(workflow).toContain("releases/download/android/matebot.apk");
    expect(workflow).not.toContain("gh release delete");
  });

  /**
   * Every shell step must parse.
   *
   * A single quote inside a single-quoted string ended one step's script early, and
   * the run failed only after a 30-minute Android build had already succeeded. `bash -n`
   * catches that in milliseconds.
   */
  it("has a syntactically valid script in every step", () => {
    for (const [index, script] of runScripts(workflow).entries()) {
      const file = path.join(directory, `step-${index}.sh`);
      writeFileSync(file, script);
      // Throws on a parse error, which is the failure this guards.
      execFileSync("bash", ["-n", file], { stdio: "pipe" });
    }
  });

  /**
   * A test build must be tellable apart from the released one.
   *
   * The shipped 1.0.12 APK is versionCode 11. EAS increments the code per build, so a
   * rebuild alone would produce 1.0.12 (12): an install that looks like the released
   * version while carrying unreleased code. The version name has to move too, and it
   * must sort above 1.0.12 so an in-place upgrade is accepted.
   */
  it("gives this build a version name no released APK shares", () => {
    const app = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../app.json"), "utf8"),
    ) as { expo: { version: string; android: { versionCode: number } } };
    // The released Android build (1.0.12, versionCode 11) must not be reproducible here.
    expect(app.expo.version).not.toBe("1.0.12");
    expect(app.expo.version > "1.0.12").toBe(true);
    // And not the version published for the previous build either.
    expect(app.expo.version).not.toBe("1.0.13");
    expect(app.expo.version > "1.0.13").toBe(true);
    // The app config's code is only a fallback; EAS owns the built value. Assert the
    // fallback is not below what has shipped, so a local build cannot look older.
    expect(app.expo.android.versionCode).toBeGreaterThanOrEqual(10);
  });
});
