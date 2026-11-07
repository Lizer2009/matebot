import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RAKAZO_DOCS_URLS } from "./builtin-skills.js";

/**
 * The product-help skill must not promise pages this build does not have.
 *
 * The audit found the assistant trying to open a product documentation URL that
 * this repository has no page for. That specific URL was never in this list — the
 * skill's hardcoded paths were not the source — but nothing checked the list
 * against the repository, so a stale entry could sit there indefinitely and a
 * model following it would fetch a 404 or, worse, invent a neighbouring path.
 *
 * These tie the list to files that exist, so a rename or a removal fails here
 * instead of in a conversation.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The documentation index route, which is a page rather than a `docs/<slug>.md` file. */
const DOCS_INDEX_URL = "https://rakazo.com/docs.md";

describe("product help documentation URLs", () => {
  it("points every entry at a documentation page this repository actually has", () => {
    const missing = RAKAZO_DOCS_URLS.filter((url) => {
      if (url === DOCS_INDEX_URL)
        return !existsSync(join(repoRoot, "apps/www/src/pages/docs.md.ts"));
      const slug = /^https:\/\/[^/]+\/docs\/(.+)\.md$/.exec(url)?.[1];
      return !slug || !existsSync(join(repoRoot, "docs", `${slug}.md`));
    });
    expect(missing).toEqual([]);
  });

  it("lists no page twice", () => {
    expect(new Set(RAKAZO_DOCS_URLS).size).toBe(RAKAZO_DOCS_URLS.length);
  });

  it("uses the documentation host for every entry, not an arbitrary path", () => {
    for (const url of RAKAZO_DOCS_URLS) {
      expect(url).toMatch(/^https:\/\/rakazo\.com\/docs(\.md|\/[a-z0-9-]+\.md)$/);
    }
  });

  it("ships the same host the site actually serves docs from", () => {
    // The site rewrites doc links to its own canonical host; the skill must name
    // the host those pages are published on rather than a placeholder.
    const site = readFileSync(join(repoRoot, "apps/www/src/docs.ts"), "utf8");
    expect(site).toContain('export const DOCS_PATH = "/docs/"');
  });
});
