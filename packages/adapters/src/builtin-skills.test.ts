import { existsSync, readFileSync } from "node:fs";
import { PRODUCT_DISPLAY_NAME } from "@matebot/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS, RAKAZO_DOCS_URLS } from "./builtin-skills.js";

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
    expect(skill.description).not.toContain("Rakazo");
  });

  it("links only to published docs pages", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === PRODUCT_DISPLAY_NAME)!;
    const urls = [...skill.content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(RAKAZO_DOCS_URLS);
    for (const url of urls) {
      const slug =
        url === "https://rakazo.com/docs.md"
          ? publishedSlugs[0]
          : /^https:\/\/rakazo\.com\/docs\/([\w-]+)\.md$/.exec(url)?.[1];
      expect(publishedSlugs, url).toContain(slug);
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });
});
