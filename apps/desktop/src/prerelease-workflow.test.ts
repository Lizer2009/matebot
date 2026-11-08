import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * A prerelease handed to one test machine must not become a channel anyone else gets.
 *
 * The stable path (`release-desktop`) only accepts vX.Y.Z tags already on main, so a
 * build from a feature branch needs its own route. That route is only safe if it
 * cannot move the pointer the desktop updater and the download page both read, and if
 * it cannot quietly publish something that is not the version it claims.
 */

const workflowsDir = path.resolve(import.meta.dirname, "../../../.github/workflows");
const text = readFileSync(path.join(workflowsDir, "release-prerelease.yml"), "utf8");
const publisherText = readFileSync(
  path.resolve(workflowsDir, "../actions/publish-image/action.yml"),
  "utf8",
);

type Step = {
  name?: string;
  uses?: string;
  shell?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
const workflow = parse(text) as {
  on: Record<string, { tags?: string[] } | null>;
  jobs: Record<string, { permissions?: Record<string, string>; steps: Step[]; needs?: unknown }>;
};

const stepsOf = (job: string) => workflow.jobs[job]!.steps;

describe("prerelease workflow", () => {
  it("does not take the stable release's tags", () => {
    const stable = readFileSync(path.join(workflowsDir, "release-desktop.yml"), "utf8");
    // Two workflows triggering on one tag would race to publish it; the stable path
    // excludes prerelease tags outright.
    expect(stable).toContain('tags: ["v*", "!v*-*"]');
  });

  it("only runs for a prerelease tag", () => {
    expect(workflow.on.push?.tags).toEqual(["v*-pr*"]);
    const validate = stepsOf("validate").find((step) => step.name?.startsWith("Require"));
    // The tag pattern is checked again in the step, so a manual dispatch cannot bypass it.
    expect(validate?.run).toContain("v[0-9]+\\.[0-9]+\\.[0-9]+-pr[0-9]+");
    expect(validate?.run).toContain("REF_TYPE");
  });

  it("refuses a tag that does not match the packaged version", () => {
    const validate = stepsOf("validate").find((step) => step.name?.startsWith("Require"));
    expect(validate?.run).toContain("require('./apps/desktop/package.json').version");
    expect(validate?.run).toContain('"$RELEASE_TAG" != "v$version"');
  });

  it("refuses to replace an existing release", () => {
    const validate = stepsOf("validate").find((step) => step.name?.startsWith("Require"));
    expect(validate?.run).toContain("releases/tags/${RELEASE_TAG}");
    expect(validate?.run).toContain("refusing to replace it");
  });

  it("publishes as a prerelease that is explicitly not Latest", () => {
    const publish = stepsOf("publish").find((step) => step.name === "Create the prerelease");
    expect(publish?.run).toContain("--prerelease");
    // Without this, a prerelease can take the pointer the updater reads.
    expect(publish?.run).toContain("--latest=false");
  });

  it("never uploads an update feed as a release asset", () => {
    // `latest.yml` is what an installed app reads. Shipping it in a prerelease would
    // let a build from a branch offer itself as an update to everyone.
    const upload = stepsOf("windows").find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const uploaded = String(upload?.with?.path ?? "");
    expect(uploaded).toContain("Matebot-Setup-*.exe");
    expect(uploaded).toContain("SHA256SUMS");
    expect(uploaded).not.toContain("latest.yml");
    const publish = stepsOf("publish").find((step) => step.name === "Create the prerelease");
    expect(publish?.run).not.toContain("latest.yml");
  });

  it("pins every action to a commit and writes only what publishing needs", () => {
    for (const match of text.matchAll(/uses:\s+([^\s#]+)/g)) {
      expect(match[1], match[1]).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(workflow.jobs.publish!.permissions).toEqual({ contents: "write" });
    // Building untrusted-ish branch code gets no write token.
    expect(workflow.jobs.windows!.permissions).toBeUndefined();
  });

  it("says in the notes what was not verified", () => {
    const notes = stepsOf("publish").find((step) => step.name === "Write the release notes");
    expect(notes?.run).toContain("Not verified");
    expect(notes?.run).toContain("no live model or provider call");
    // The YAML block scalar folds indentation, so the phrase wraps across lines.
    expect(notes?.run?.replace(/\s+/g, " ")).toContain("builds its address at run time");
  });
});

describe("image publishing from a prerelease tag", () => {
  it("does not move a floating stable tag", () => {
    // vMAJOR.MINOR is what a self-hoster pins to follow patches. A prerelease build
    // must not appear under it, or pinning it silently ships a branch build.
    expect(publisherText).toContain("pattern=v{{major}}.{{minor}},enable=");
    expect(publisherText).toContain("!contains(github.ref, '-')");
    // latest is already guarded, and must stay that way for the same reason.
    expect(publisherText).toMatch(
      /type=raw,value=latest,enable=\$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && !contains\(github\.ref, '-'\) \}\}/,
    );
    // The exact version tag is fine: it names one immutable build.
    expect(publisherText).toContain("type=semver,pattern=v{{version}}");
  });
});
