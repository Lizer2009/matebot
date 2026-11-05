import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Folder name the pre-rename shell used under the platform's app-data root.
 *
 * Electron derives `userData` from the packaged display name, so installs from
 * before the rename to Matebot keep their saved server, screen driver, computers,
 * and local Compose stack in a folder with this name.
 */
export const LEGACY_PRODUCT_SLUG = "Rakazo";

export type UserDataMigration = "unneeded" | "moved" | "copied" | "failed";

/**
 * Resolves the profile folder this launch should use, carrying over a pre-rename
 * one when the new folder does not exist yet.
 *
 * This runs before Electron's `ready` event, so it stays synchronous: a rename is
 * instant, and the copy fallback only runs when the two folders are on different
 * volumes, where an atomic rename is impossible.
 *
 * A failure is reported rather than thrown. Starting with a fresh profile is a
 * valid state, so a broken migration must never stop the app from opening.
 */
export function resolveUserDataDir(input: { defaultDir: string; legacyName?: string }): {
  dir: string;
  migration: UserDataMigration;
} {
  const { defaultDir, legacyName = LEGACY_PRODUCT_SLUG } = input;
  const legacyDir = path.join(path.dirname(defaultDir), legacyName);
  if (path.resolve(legacyDir) === path.resolve(defaultDir)) {
    return { dir: defaultDir, migration: "unneeded" };
  }
  // A profile that already ran under the new name owns its files; never merge into it.
  if (existsSync(defaultDir) || !existsSync(legacyDir)) {
    return { dir: defaultDir, migration: "unneeded" };
  }

  try {
    mkdirSync(path.dirname(defaultDir), { recursive: true });
    renameSync(legacyDir, defaultDir);
    return { dir: defaultDir, migration: "moved" };
  } catch {
    // Different volume, or a rename the filesystem refuses; copy instead.
  }

  try {
    cpSync(legacyDir, defaultDir, { recursive: true, errorOnExist: false, force: true });
    // Only retire the old folder once the copy landed.
    if (!existsSync(defaultDir)) return { dir: defaultDir, migration: "failed" };
    rmSync(legacyDir, { recursive: true, force: true });
    return { dir: defaultDir, migration: "copied" };
  } catch {
    return { dir: defaultDir, migration: "failed" };
  }
}
