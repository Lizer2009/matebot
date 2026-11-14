import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The package barrel is what the web app imports, and it must stay browser-safe.
 *
 * `node:crypto` and friends are externalized for the browser, so a single
 * `export * from` of a module that hashes or reads a file makes the whole app fail at
 * start with "has been externalized for browser compatibility": a blank page, every
 * screen gone, and no failing unit test, because the tests run on Node where the import
 * works. That is how `interaction-card-key.ts` once arrived — the key belongs to the
 * server, the module was exported from the barrel, and the browser suite failed on 37
 * unrelated specs. A module that needs a Node builtin belongs behind a
 * `@matebot/core/node/...` entry instead (see `approval-effect-key.ts`).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "index.ts");

/** Re-exports the barrel follows. A module reached this way ships to the browser. */
const REEXPORT = /export\s+\*\s+from\s+"(\.[^"]+)"/g;
/** A Node builtin, in either spelling, imported by a module the barrel reaches. */
const NODE_BUILTIN = /^\s*(?:import|export)[^;]*?from\s+"(node:[^"]+)"/gm;

function browserReachable(start: string): string[] {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(REEXPORT)) {
      const target = path.resolve(path.dirname(file), match[1]!).replace(/\.js$/, ".ts");
      queue.push(target);
    }
  }
  return [...seen];
}

describe("the core barrel", () => {
  it("reaches no module that imports a Node builtin", () => {
    const offenders = browserReachable(entry).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(NODE_BUILTIN)].map(
        (match) => `${path.relative(here, file)} imports ${match[1]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  // `node:crypto` is the one that reached the browser once, so the module is pinned
  // behind its own entry rather than only being absent from the barrel.
  it("serves the card key from its node-only entry", () => {
    expect(readFileSync(entry, "utf8")).not.toContain("interaction-card-key");
  });
});
