import { describe, expect, it } from "vitest";
import { describeToolActivity } from "./pi-runtime-tools.js";

describe("describeToolActivity", () => {
  it("summarizes builtin tools with their most informative argument", () => {
    expect(describeToolActivity("shell", { command: "pnpm test --filter web" })).toBe(
      "Running a command",
    );
    expect(describeToolActivity("read_file", { path: "notes/plan.md" })).toBe(
      "Reading notes/plan.md",
    );
    expect(describeToolActivity("write_file", { path: "out.csv", content: "…" })).toBe(
      "Writing out.csv",
    );
    expect(describeToolActivity("list_fleet", {})).toBe("Checking your bots");
    expect(describeToolActivity("render_plot", { spec: {} })).toBe("Rendering a chart");
    expect(describeToolActivity("save_page", { help: true })).toBe(
      "Reading the page kit reference",
    );
    expect(describeToolActivity("save_page", { title: "Plan", source: "x" })).toBe(
      "Writing the page code",
    );
    expect(describeToolActivity("present_interaction", { plan: { intent: "email.compose" } })).toBe(
      "Preparing an editable draft",
    );
    expect(describeToolActivity("add_mcp_server", { name: "Linear" })).toBe(
      "Connecting MCP server: Linear",
    );
    expect(describeToolActivity("run_subagent", { name: "scout", task: "…" })).toBe(
      "Delegating to helper: scout",
    );
    expect(describeToolActivity("create_space", { name: "Customer support" })).toBe(
      "Creating space: Customer support",
    );
    expect(describeToolActivity("web_search", { query: "matebot agents" })).toBe(
      "Searching the web: matebot agents",
    );
    expect(describeToolActivity("web_fetch", { url: "https://example.com" })).toBe(
      "Reading page: https://example.com/",
    );
  });

  it("hides MCP server and remote tool names", () => {
    expect(describeToolActivity("mcp__brex__list_expenses", {})).toBe("Working…");
    expect(describeToolActivity("mcp__demo-oauth__greet", {})).toBe("Working…");
  });

  it("does not echo shell or computer commands", () => {
    const command =
      "powershell -NoProfile -Command \"[IO.File]::WriteAllBytes('C:\\\\Temp\\\\dump.py', [Convert]::FromBase64String('abc'))\"";
    expect(describeToolActivity("shell", { command })).toBe("Running a command");
    expect(describeToolActivity("user_computer_shell", { command })).toBe(
      "Working on your computer",
    );
    expect(describeToolActivity("user_computer_shell", { command })).not.toContain("python");
    expect(describeToolActivity("user_computer_shell", { command })).not.toContain("WriteAllBytes");
  });

  it("maps connector batches to intents, never internal names", () => {
    expect(
      describeToolActivity("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "GOOGLECALENDAR_FIND_EVENT", arguments: {} }],
      }),
    ).toBe("Checking the calendar");
    expect(
      describeToolActivity("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.test" } }],
      }),
    ).toBe("Sending email");
    expect(
      describeToolActivity("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }],
      }),
    ).toBe("Checking email");
    const mixed = describeToolActivity("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [
        { tool_slug: "GMAIL_SEND_EMAIL", arguments: {} },
        { tool_slug: "GOOGLECALENDAR_FIND_EVENT", arguments: {} },
      ],
    });
    expect(mixed).toBe("Working…");
    expect(mixed).not.toContain("COMPOSIO_");
    expect(mixed).not.toContain("GMAIL_");
    expect(describeToolActivity("GMAIL_SEND_EMAIL", {})).toBe("Sending email");
    expect(describeToolActivity("COMPOSIO_SEARCH_TOOLS", {})).toBe("Working…");
  });

  it("strips signed-URL query and fragment from web_fetch activity", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@cdn.example.test/doc.pdf?X-Amz-Signature=abc123&token=leak#frag",
    });
    expect(line).toBe("Reading page: https://cdn.example.test/doc.pdf");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("X-Amz-Signature");
    expect(line).not.toContain("token=");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("frag");
  });

  it("does not echo secrets from malformed web_fetch URLs", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@[",
    });
    expect(line).toBe("Reading page: [invalid URL]");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("user:");
  });

  it("falls back to a short intent, not the tool name", () => {
    expect(describeToolActivity("destination_write", undefined)).toBe("Working…");
  });
});
