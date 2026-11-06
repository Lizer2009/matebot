import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

/**
 * The model can only edit a card if the run offers it a tool for that. These
 * tests pin the two facts the primary acceptance criterion depends on: the
 * tool exists in the registry, and a run with A2UI on is offered it.
 */

const base = {
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  messagingChannelRun: false,
};

describe("edit_interaction tool registration", () => {
  it("is defined with an input schema the model can satisfy", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "edit_interaction");
    expect(tool).toBeTruthy();
    expect(tool).toBeTruthy();
    if (!tool) return;
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(Object.keys(properties ?? {})).toEqual(expect.arrayContaining(["fields", "revision"]));
    // The interaction is optional so an unnamed reference can resolve or clarify.
    expect(Object.keys(properties ?? {})).toContain("interactionId");
  });

  // A prose edit must not be a path to sending or to writing a secret.
  it("describes itself as an edit, not a send", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "edit_interaction");
    const description = tool?.description ?? "";
    expect(description).toMatch(/edit|change|update/i);
    expect(description).toMatch(/does not send|never sends|not send/i);
    expect(description).not.toMatch(/smtp|app password/i);
  });

  it("is listed as a builtin the owner can disable", async () => {
    const { BUILTIN_TOOL_NAMES } = await import("@matebot/contracts");
    expect(BUILTIN_TOOL_NAMES).toContain("edit_interaction");
  });
});

describe("edit_interaction tool selection", () => {
  it("is offered only when A2UI is enabled", () => {
    const off = selectBuiltinToolsForRun({ ...base, a2uiEnabled: false }).map((tool) => tool.name);
    const on = selectBuiltinToolsForRun({ ...base, a2uiEnabled: true }).map((tool) => tool.name);
    expect(off).not.toContain("edit_interaction");
    expect(on).toContain("edit_interaction");
  });

  // A background run cannot hold a card conversation.
  it("is withheld from background runs, like present_interaction", () => {
    const names = selectBuiltinToolsForRun({
      ...base,
      a2uiEnabled: true,
      // The background trigger set is `tickets`; a routine still sees cards.
      trigger: "tickets",
    }).map((tool) => tool.name);
    expect(names).not.toContain("edit_interaction");
    expect(names).not.toContain("present_interaction");
  });

  it("is withheld from messaging-channel runs, like present_interaction", () => {
    const names = selectBuiltinToolsForRun({
      ...base,
      a2uiEnabled: true,
      messagingChannelRun: true,
    }).map((tool) => tool.name);
    expect(names).not.toContain("edit_interaction");
  });
});
