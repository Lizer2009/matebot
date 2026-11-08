import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { documentOriginConfigured, documentOriginFromEnv } from "./document-origin.js";
import {
  DOCS_ROOT_PATH,
  documentationUrl,
  PRODUCT_DOCS_FALLBACK,
  PRODUCT_DOCUMENTATION,
} from "./product-docs.js";

/**
 * The help skill must describe this build, and must not be able to invent a page.
 *
 * The audit found the assistant trying to open a product documentation path this
 * repository has no page for. The old index was hand-written and pointed at another
 * product's host, so nothing tied it to the pages that ship and a fork's users were
 * sent to a site describing a different build.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("product documentation index", () => {
  it("lists a page only when the file exists", () => {
    const missing = PRODUCT_DOCUMENTATION.filter(
      (page) => !existsSync(join(repoRoot, "docs", `${page.slug}.md`)),
    );
    expect(missing).toEqual([]);
  });

  it("says something different about each page", () => {
    const topics = PRODUCT_DOCUMENTATION.map((page) => page.topics);
    expect(new Set(topics).size).toBe(topics.length);
    const slugs = PRODUCT_DOCUMENTATION.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("agrees with the slugs the site itself publishes", () => {
    // The site builds from its own list; a page the skill names but the site does
    // not build is a 404 the model was told to fetch.
    const site = readFileSync(join(repoRoot, "apps/www/src/docs.ts"), "utf8");
    const siteSlugs = new Set(
      [...site.matchAll(/\{\s*slug:\s*"([a-z0-9-]+)"/g)].map((match) => match[1]!),
    );
    const notPublished = PRODUCT_DOCUMENTATION.map((page) => page.slug).filter(
      (slug) => !siteSlugs.has(slug),
    );
    expect(notPublished).toEqual([]);
  });

  it("has no upstream host anywhere in the index", () => {
    const serialized = JSON.stringify(PRODUCT_DOCUMENTATION);
    // The index carries slugs, not URLs; a host name here would be a second source
    // of truth for where docs live.
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it("builds the docs root for the first page and a slug path for the rest", () => {
    expect(documentationUrl("https://docs.example.test", "getting-started")).toBe(
      `https://docs.example.test${DOCS_ROOT_PATH}`,
    );
    expect(documentationUrl("https://docs.example.test", "integrations")).toBe(
      `https://docs.example.test${DOCS_ROOT_PATH}integrations/`,
    );
  });

  it("tolerates a trailing slash on the configured origin", () => {
    expect(documentationUrl("https://docs.example.test/", "integrations")).toBe(
      "https://docs.example.test/docs/integrations/",
    );
  });
});

describe("offline fallback", () => {
  it("explains connecting an app and an MCP server without a network read", () => {
    expect(PRODUCT_DOCS_FALLBACK).toMatch(/Integrations/);
    expect(PRODUCT_DOCS_FALLBACK).toMatch(/MCP/);
  });

  it("explains Cursor cloud agents, which the audit asked about", () => {
    expect(PRODUCT_DOCS_FALLBACK).toMatch(/Cursor cloud agents/);
    expect(PRODUCT_DOCS_FALLBACK).toMatch(/own cloud/);
  });

  it("names no upstream product host", () => {
    expect(PRODUCT_DOCS_FALLBACK).not.toMatch(/rakazo/i);
  });
});

describe("documentOriginFromEnv", () => {
  it("uses the configured marketing origin", () => {
    expect(documentOriginFromEnv({ RAKAZO_MARKETING_URL: "https://docs.example.test" })).toBe(
      "https://docs.example.test",
    );
  });

  it("falls back to the product's own origin when unset", () => {
    const origin = documentOriginFromEnv({});
    expect(origin).toMatch(/^https:\/\//);
    expect(origin).not.toMatch(/rakazo/i);
  });

  it("ignores a value that is not an http(s) origin", () => {
    expect(documentOriginFromEnv({ RAKAZO_MARKETING_URL: "javascript:alert(1)" })).not.toMatch(
      /javascript:/,
    );
  });
});

describe("whether a deployment named its own documentation origin", () => {
  it("is configured only for a real http(s) origin", () => {
    expect(documentOriginConfigured({ RAKAZO_MARKETING_URL: "https://docs.example.test" })).toBe(
      true,
    );
    expect(documentOriginConfigured({ RAKAZO_MARKETING_URL: "http://localhost:3000" })).toBe(true);
    expect(documentOriginConfigured({})).toBe(false);
    expect(documentOriginConfigured({ RAKAZO_MARKETING_URL: "" })).toBe(false);
    expect(documentOriginConfigured({ RAKAZO_MARKETING_URL: "javascript:alert(1)" })).toBe(false);
    expect(documentOriginConfigured({ RAKAZO_MARKETING_URL: "not a url" })).toBe(false);
  });
});
