import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productDocumentationUrls } from "./builtin-skills.js";

/**
 * The help skill must describe this build, and must name only pages that exist.
 *
 * The audit found the assistant fetching a product documentation path this
 * repository has no page for, after reading a skill whose index was hand-written
 * and pointed at another product's host. Nothing checked that index against the
 * pages that ship, so a fork's users were sent to a site describing a different
 * build, and a model following a stale entry could fetch a 404 or invent a
 * neighbouring path.
 *
 * These tie the index to real files on the deployment's own origin.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("product help documentation URLs", () => {
  it("names a page for every entry, and every named page exists", () => {
    const urls = productDocumentationUrls({ RAKAZO_MARKETING_URL: "https://docs.example.test" });
    const missing = urls.filter((url) => {
      const slug = /\/docs\/([a-z0-9-]+)\/$/.exec(url)?.[1];
      // The docs root is the first page and has its own route.
      if (!slug) return false;
      return !existsSync(join(repoRoot, "docs", `${slug}.md`));
    });
    expect(missing).toEqual([]);
  });

  it("keeps every entry on the deployment's configured origin", () => {
    const urls = productDocumentationUrls({ RAKAZO_MARKETING_URL: "https://docs.example.test" });
    for (const url of urls) expect(url.startsWith("https://docs.example.test/docs/")).toBe(true);
  });

  it("names no upstream product host", () => {
    const urls = productDocumentationUrls({});
    expect(urls.join("\n")).not.toMatch(/rakazo/i);
  });

  it("accepts only the closed set, so a constructed path is not on it", () => {
    const urls = productDocumentationUrls({ RAKAZO_MARKETING_URL: "https://docs.example.test" });
    // The exact URL the audit saw the assistant try to open.
    expect(urls).not.toContain("https://docs.example.test/docs/cloud-agents/");
    expect(urls).not.toContain("https://docs.example.test/integrations");
  });
});
