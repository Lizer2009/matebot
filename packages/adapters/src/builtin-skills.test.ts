import { existsSync, readFileSync } from "node:fs";
import { PRODUCT_DISPLAY_NAME } from "@matebot/core";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_SKILLS,
  productDocumentationUrls,
  resolveSkillDocumentation,
} from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
const publishedSlugs = [
  ...readFileSync(repoFile("apps/www/src/docs.ts"), "utf8").matchAll(/slug: "([\w-]+)"/g),
].map((match) => match[1]);

describe("product help skill", () => {
  it("is named for this product, so the slash picker labels it correctly", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === PRODUCT_DISPLAY_NAME)!;
    expect(skill).toBeDefined();
    expect(skill.content).toContain(`name: ${PRODUCT_DISPLAY_NAME}`);
    expect(skill.description.startsWith(`How to use or set up ${PRODUCT_DISPLAY_NAME}:`)).toBe(
      true,
    );
    // It names this product, and never the product it was forked from.
    expect(skill.description).not.toContain("Rakazo");
  });

  it("links only to published docs pages, on this deployment's origin", () => {
    // The body carries a marker until a model reads it; resolve it the same way
    // `skill_read` does, since that is the text that actually reaches the model.
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === PRODUCT_DISPLAY_NAME)!;
    const content = resolveSkillDocumentation(skill.content);
    const urls = [...content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(productDocumentationUrls());
    for (const url of urls) {
      const slug = /\/docs\/([\w-]+)\/$/.exec(url)?.[1];
      if (!slug) continue;
      expect(publishedSlugs, url).toContain(slug);
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });

  it("answers a Cursor or MCP question even when no page can be fetched", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === PRODUCT_DISPLAY_NAME)!;
    // The audit saw this exact question. The body must carry enough to answer it
    // without a network read, and must say that is what it is doing.
    expect(skill.content).toMatch(/MCP server/i);
    expect(skill.content).toMatch(/Cursor cloud agents/i);
    expect(skill.content).toMatch(/short answer rather than the full page/i);
  });

  it("tells the model the index is a closed set", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === PRODUCT_DISPLAY_NAME)!;
    expect(skill.content).toMatch(/never construct a URL, guess a path/);
  });
});
