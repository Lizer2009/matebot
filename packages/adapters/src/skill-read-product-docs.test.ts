import { PRODUCT_DISPLAY_NAME } from "@matebot/core";
import { describe, expect, it, vi } from "vitest";
import { skillReadFromTool } from "./skill-tools.js";

/**
 * Reading the product help the way a run does.
 *
 * The audit's model called `skill_read` and then fetched a documentation path this
 * build does not have. String assertions on the skill body would not have caught
 * that: what matters is what `skill_read` actually hands the model. These go
 * through the real tool entry with a minimal store, and check the answer it
 * receives can address the question that was actually asked — connecting an MCP
 * server and a Cursor cloud agent — without a network read.
 */

vi.stubEnv("RAKAZO_MARKETING_URL", "https://docs.example.test");

/** Only the builtin lookup runs; a builtin skill never touches the table. */
function prisma() {
  return {
    agentSkill: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    skillAssignment: { findMany: vi.fn(async () => []) },
  } as never;
}

const owner = { spaceId: "space-1", userId: "user-1" };

describe("skill_read on the product help skill", () => {
  it("returns the product's own documentation, not another product's", async () => {
    const result = await skillReadFromTool(prisma(), owner, { name: PRODUCT_DISPLAY_NAME });
    const content = String(result.content ?? "");
    expect(content).toContain("docs.example.test/docs/integrations/");
    // Nothing points at the previous product's host any more.
    expect(content).not.toMatch(/rakazo\.com/i);
  });

  it("can answer how to connect an MCP server without fetching anything", async () => {
    const result = await skillReadFromTool(prisma(), owner, { name: PRODUCT_DISPLAY_NAME });
    const content = String(result.content ?? "");
    // The offline fallback is in the body, so a refused or offline fetch still has
    // something true to say rather than silence.
    expect(content).toMatch(/MCP server/i);
    expect(content).toMatch(/encrypted and never sent to the model/i);
    expect(content).toMatch(/approve it in the chat/i);
  });

  it("can answer what a Cursor cloud agent is without fetching anything", async () => {
    const result = await skillReadFromTool(prisma(), owner, { name: PRODUCT_DISPLAY_NAME });
    const content = String(result.content ?? "");
    expect(content).toMatch(/Cursor cloud agents/i);
    expect(content).toMatch(/own cloud/i);
    expect(content).toMatch(/cancel the run/i);
  });

  it("says the short answer is not the full page, so it never overclaims", async () => {
    const result = await skillReadFromTool(prisma(), owner, { name: PRODUCT_DISPLAY_NAME });
    expect(String(result.content ?? "")).toMatch(/short answer rather than the full page/i);
  });

  it("offers no page for a topic this build does not document", async () => {
    const result = await skillReadFromTool(prisma(), owner, { name: PRODUCT_DISPLAY_NAME });
    const content = String(result.content ?? "");
    // The exact path the audit saw attempted: there is no such page here.
    expect(content).not.toContain("/docs/cloud-agents/");
    // And the model is told not to invent one.
    expect(content).toMatch(/never construct a URL, guess a path/);
  });
});
