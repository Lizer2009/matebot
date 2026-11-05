import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUserDataDir } from "./user-data-migration.js";

const roots: string[] = [];

function root() {
  const dir = mkdtempSync(path.join(tmpdir(), "matebot-user-data-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  // Restore traversal first: a deliberately read-only directory blocks removal of its parent.
  for (const dir of roots) chmodSync(dir, 0o700);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("legacy user-data folder", () => {
  it("carries a pre-rename profile into the new folder", () => {
    const base = root();
    const legacyDir = path.join(base, "Rakazo");
    const defaultDir = path.join(base, "Matebot");
    mkdirSync(path.join(legacyDir, "stack"), { recursive: true });
    writeFileSync(path.join(legacyDir, "setup.json"), '{"mode":"existing"}\n');
    writeFileSync(path.join(legacyDir, "stack", ".env"), "WEB_PORT=5173\n");

    expect(resolveUserDataDir({ defaultDir })).toEqual({ dir: defaultDir, migration: "moved" });

    expect(readFileSync(path.join(defaultDir, "setup.json"), "utf8")).toBe('{"mode":"existing"}\n');
    expect(readFileSync(path.join(defaultDir, "stack", ".env"), "utf8")).toBe("WEB_PORT=5173\n");
  });

  it("leaves a profile that already exists under the new name alone", () => {
    const base = root();
    const legacyDir = path.join(base, "Rakazo");
    const defaultDir = path.join(base, "Matebot");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "setup.json"), '{"mode":"existing"}\n');
    writeFileSync(path.join(defaultDir, "setup.json"), '{"mode":"new"}\n');

    expect(resolveUserDataDir({ defaultDir })).toEqual({ dir: defaultDir, migration: "unneeded" });

    expect(readFileSync(path.join(defaultDir, "setup.json"), "utf8")).toBe('{"mode":"new"}\n');
    // The old build keeps reading its own folder until it is removed by hand.
    expect(readFileSync(path.join(legacyDir, "setup.json"), "utf8")).toBe('{"mode":"existing"}\n');
  });

  it("does nothing on a first install", () => {
    const base = root();
    expect(resolveUserDataDir({ defaultDir: path.join(base, "Matebot") })).toEqual({
      dir: path.join(base, "Matebot"),
      migration: "unneeded",
    });
  });

  it("reports a failure rather than throwing when the folder cannot be moved", () => {
    const base = root();
    const appData = path.join(base, "appdata");
    const legacyDir = path.join(appData, "Rakazo");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "setup.json"), "{}\n");
    // A read-only app-data root refuses both the rename and the copy's mkdir.
    chmodSync(appData, 0o500);
    roots.unshift(appData);

    expect(resolveUserDataDir({ defaultDir: path.join(appData, "Matebot") })).toEqual({
      dir: path.join(appData, "Matebot"),
      migration: "failed",
    });
  });
});
