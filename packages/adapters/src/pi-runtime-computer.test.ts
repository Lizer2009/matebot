import type { ConnectorTool } from "@matebot/adapter-kit";
import { PRODUCT_DISPLAY_NAME } from "@matebot/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  result: undefined as unknown,
  systemPrompt: "",
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tool: {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    constructor(options: {
      initialState: {
        systemPrompt: string;
        tools: Array<{
          name: string;
          execute: (toolCallId: string, params: unknown) => Promise<unknown>;
        }>;
      };
    }) {
      fakeAgentState.systemPrompt = options.initialState.systemPrompt;
      const tool = options.initialState.tools.find(
        (candidate) => candidate.name === "computer_observe",
      );
      if (!tool) throw new Error("computer_observe was not exposed");
      this.tool = tool;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      fakeAgentState.result = await this.tool.execute("observe-1", {});
    }

    async waitForIdle() {}

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "computer-test-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { COMPUTER_SCREEN_UNAVAILABLE } from "./computer-screens.js";
import { defaultSystemPrompt, PiAgentRuntime } from "./pi-runtime.js";

const computerObserve: ConnectorTool = {
  name: "computer_observe",
  description: "Observe the computer",
  inputSchema: { type: "object", properties: {} },
};

describe("Pi computer tool dispatch", () => {
  beforeEach(() => {
    fakeAgentState.result = undefined;
    fakeAgentState.systemPrompt = "";
  });

  it("introduces the bot as this product, not the upstream one", () => {
    for (const prompt of [defaultSystemPrompt(true), defaultSystemPrompt(false)]) {
      expect(prompt).toContain(`You are a ${PRODUCT_DISPLAY_NAME} bot with`);
      expect(prompt).not.toContain("Matebot");
    }
    expect(defaultSystemPrompt(true)).toContain("a real computer");
    expect(defaultSystemPrompt(false)).toContain("a persistent sandbox filesystem and shell");
  });

  it("forwards screenshots as image content for any Pi model provider", async () => {
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "look at the screen",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [computerObserve],
        model: { provider: "test", id: "computer-test-model" },
        executeTool: async () => ({
          kind: "agent_tool_result",
          content: [
            { type: "text", text: "computer observed" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          details: { frameId: "frame-1" },
        }),
      },
      {
        operationId: "computer-test",
        traceId: "computer-test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime so the fake agent executes the tool.
    }

    expect(fakeAgentState.result).toMatchObject({
      content: [{ type: "text" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    });
    expect(fakeAgentState.systemPrompt).toBe("Follow the user's instructions.");
  });

  it("keeps the run alive when a graphical tool returns an error object", async () => {
    const runtime = new PiAgentRuntime();
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run-screen-error",
        prompt: "look at the screen",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [computerObserve],
        model: { provider: "test", id: "computer-test-model" },
        executeTool: async () => ({ error: COMPUTER_SCREEN_UNAVAILABLE }),
      },
      {
        operationId: "computer-test",
        traceId: "computer-test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.result).toMatchObject({
      content: [{ type: "text" }],
      details: { error: expect.stringMatching(/temporarily busy/) },
    });
    expect(events.some((event) => event.text?.includes("I hit a problem"))).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });
});
