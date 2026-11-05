import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/desktop-windows-installer.yml"),
  "utf8",
);
const steps = (
  parse(workflow) as {
    jobs: { installer: { steps: Array<{ name?: string; shell?: string; run?: string }> } };
  }
).jobs.installer.steps;
const packageStep = steps.find((step) => step.name === "Package the unsigned installer");

describe("unsigned Windows installer workflow", () => {
  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("keeps the unsigned config flag in one argument", () => {
    // Windows runners default to `pwsh`, which splits `-c.win.signExecutable=false` at the
    // dot, so electron-builder reads `.win.signExecutable=false` as a config file path.
    expect(packageStep?.shell).toBe("bash");
    expect(packageStep?.run).toContain('"-c.win.signExecutable=false"');
  });

  it("never asks for signing credentials", () => {
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toContain("forceCodeSigning");
    expect(workflow).not.toMatch(/azureSignOptions|CSC_LINK/);
  });

  it("uploads the installer the verify step checks", () => {
    expect(workflow).toContain("apps/desktop/out/Matebot-Setup-*.exe");
    expect(workflow).toContain("apps/desktop/out/latest.yml");
    expect(workflow).toContain("if-no-files-found: error");
  });
});
