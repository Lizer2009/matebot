import { describe, expect, it } from "vitest";
import { agentConnectionTools } from "./builtin-tools.js";
import {
  CORE_BUILTIN_TOOL_NAMES,
  FIND_TOOL,
  findTools,
  partitionTools,
  USE_TOOL,
} from "./builtin-tool-bridge.js";
import { NAME_INDEX_MAX_BYTES } from "./lazy-tool-catalog.js";
import { describeToolActivity } from "./pi-runtime-tools.js";
import { BUILTIN_AGENT_TOOL_NAMES, selectBuiltinToolsForRun } from "./run-tool-selection.js";

const ownerChat = selectBuiltinToolsForRun({
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  historyRetrievalEnabled: true,
  messagingChannelRun: false,
  fleetManagement: true,
  followUpFromUser: true,
});

const definitionBytes = (tools: typeof ownerChat) =>
  Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
  );

describe("built-in tool bridge", () => {
  it("lists a pinned tool set within a byte budget on an owner chat run", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "ask_user",
      "attach_file",
      "connect_app",
      "find_tool",
      "list_files",
      "message_user",
      "read_file",
      "read_history",
      "remember",
      "request_secret",
      "request_takeover",
      "run_subagent",
      "schedule_create",
      "schedule_list",
      "search_history",
      "shell",
      "skill_read",
      "update_bot",
      "update_preferences",
      "use_tool",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
    // request_secret carries the card and contact kinds; update_bot carries instructions paging.
    // Two of these descriptions name the product, so the budget moves with the product name.
    // `find_tool` indexes every deferred tool by name, so adding one (`present_result`)
    // grows this by its name and group, not by its schema. `cancel_interaction`
    // costs its 20-byte name for the same reason; the budget moves by exactly that.
    expect(definitionBytes(listed)).toBeLessThanOrEqual(31_932);
    expect(deferred.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["render_plot", "create_space", "generate_secret", "scratchpad_add"]),
    );
  });

  it("names only real built-ins as core", () => {
    for (const name of CORE_BUILTIN_TOOL_NAMES) expect(BUILTIN_AGENT_TOOL_NAMES).toContain(name);
  });

  it("lists every tool when none is deferred", () => {
    const core = ownerChat.filter((tool) => CORE_BUILTIN_TOOL_NAMES.has(tool.name));
    expect(partitionTools(core)).toEqual({ listed: core, deferred: [] });
  });

  it("names deferred tools by area in find_tool, without schemas", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    const description = listed.find((tool) => tool.name === FIND_TOOL)!.description;
    for (const tool of deferred) expect(description).toContain(tool.name);
    expect(description).toContain("secrets:\n");
    expect(description).not.toContain("inputSchema");
    expect(listed.some((tool) => tool.name === USE_TOOL)).toBe(true);
  });

  it("finds exact names and ranks a query over names, descriptions and parameters", () => {
    const { deferred } = partitionTools(ownerChat);
    const plot = findTools(deferred, { names: ["render_plot", "shell", "nope"] });
    expect(plot.tools.map((tool) => tool.name)).toEqual(["render_plot"]);
    expect(plot.tools[0]!.inputSchema).toEqual(
      deferred.find((tool) => tool.name === "render_plot")!.inputSchema,
    );
    expect(plot.unknown).toEqual(["shell", "nope"]);

    const names = (query: string) => findTools(deferred, { query }).tools.map((tool) => tool.name);
    expect(names("chart")).toContain("render_plot");
    expect(names("new space")[0]).toBe("create_space");
    expect(names("generate password")[0]).toBe("generate_secret");
    expect(names("scratchpad add")[0]).toBe("scratchpad_add");
    expect(names("scratchpad").length).toBe(3);
    expect(findTools(deferred, { query: "zzzz" })).toMatchObject({
      tools: [],
      hint: expect.any(String),
    });
  });

  it("never finds a tool the bot turned off", () => {
    const { listed, deferred } = partitionTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        disabledBuiltinTools: ["render_plot"],
      }),
    );
    expect(findTools(deferred, { names: ["render_plot"] })).toMatchObject({
      tools: [],
      unknown: ["render_plot"],
    });
    expect(listed.find((tool) => tool.name === FIND_TOOL)!.description).not.toContain(
      "render_plot",
    );
  });

  it("shows the real tool as activity", () => {
    expect(
      describeToolActivity(USE_TOOL, { name: "create_space", arguments: { name: "Finance" } }),
    ).toBe("Creating space: Finance");
  });

  it("drops the inline name index when deferred tools overflow the catalog budget", () => {
    const deferred = Array.from({ length: 80 }, (_, i) => ({
      name: `scratchpad_extra_${String(i).padStart(3, "0")}_tool`,
      description: "x",
      inputSchema: { type: "object", properties: {} },
    }));
    // partitionTools only defers names in the built-in set. Register the fixture, then
    // remove it so later cases still see the real catalog.
    for (const tool of deferred) BUILTIN_AGENT_TOOL_NAMES.add(tool.name);
    try {
      const { listed } = partitionTools(deferred);
      const description = listed.find((tool) => tool.name === FIND_TOOL)!.description;
      expect(Buffer.byteLength(description, "utf8")).toBeLessThan(
        400 + NAME_INDEX_MAX_BYTES + 200,
      );
      expect(description).toMatch(/Sources:/);
      expect(description).not.toContain("scratchpad_extra_000_tool");
    } finally {
      for (const tool of deferred) BUILTIN_AGENT_TOOL_NAMES.delete(tool.name);
    }
  });

  it("defers agent-connection tools instead of listing their schemas", () => {
    const { listed, deferred } = partitionTools(agentConnectionTools);
    expect(deferred.map((tool) => tool.name).sort()).toEqual([
      "connect_agent",
      "message_agent",
      "respond_agent_connection",
    ]);
    expect(listed.map((tool) => tool.name).sort()).toEqual(["find_tool", "use_tool"]);
    for (const name of ["connect_agent", "message_agent", "respond_agent_connection"]) {
      expect(CORE_BUILTIN_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});
