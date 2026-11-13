import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

/**
 * Files still allowed to write `interaction.status` directly.
 *
 * This list may only shrink. Every entry is a card path that batches B~E will
 * move onto `settleInteraction`; adding a name here is how the kernel gets
 * quietly hollowed out, so the test also fails if the list grows.
 */
const STATUS_WRITE_ALLOWLIST = [
  "packages/adapters/src/interaction-publish.ts",
  "packages/adapters/src/interaction-kernel-store.ts",
  "packages/adapters/src/interaction-field-writer.ts",
  "packages/adapters/src/interaction-email-outcome.ts",
  "packages/adapters/src/interaction-result-publish.ts",
  "packages/db/src/interactions.ts",
  "apps/api/src/interaction-service.ts",
  "apps/api/src/interaction-resume.ts",
].sort();

const KERNEL_STORE = "packages/adapters/src/interaction-kernel-store.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "generated",
  "migrations",
  "android",
  "ios",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
}

const INTERACTION_WRITE = /\binteraction\s*\.\s*(?:updateMany|update|upsert)\s*\(/g;

function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === quote) return i;
  }
  return source.length - 1;
}

/**
 * The call's full argument list, from its opening parenthesis to the matching
 * closing one. Slicing to the first `)` instead would truncate any call whose
 * arguments hold a nested call before `status:` and silently miss the write.
 */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(source, i);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1);
}

function writesInteractionStatus(source: string): boolean {
  for (const match of source.matchAll(INTERACTION_WRITE)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    if (/\bstatus\s*:/.test(callArguments(source, openParen))) return true;
  }
  return false;
}

function statusWriteFiles(): string[] {
  const files: string[] = [];
  for (const dir of ["packages", "apps"]) walk(join(ROOT, dir), files);
  return files
    .filter((file) => writesInteractionStatus(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file))
    .sort();
}

describe("interaction status write guard", () => {
  it("only lets allowlisted files write a card status", () => {
    const offenders = statusWriteFiles().filter((file) => !STATUS_WRITE_ALLOWLIST.includes(file));
    expect(offenders).toEqual([]);
  });

  it("still sees the kernel store's own status write", () => {
    expect(statusWriteFiles()).toContain(KERNEL_STORE);
  });

  it("keeps the allowlist sorted and free of duplicates, so shrinking it is a diff of one line", () => {
    expect(STATUS_WRITE_ALLOWLIST).toEqual([...new Set(STATUS_WRITE_ALLOWLIST)].sort());
  });
});
