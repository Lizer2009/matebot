import { describe, expect, it } from "vitest";
import { connectorTool } from "./run-tools-integrations.js";

/**
 * What the model reads back from a connector call.
 *
 * A catalog search returns tool schemas. It is not an action, and the model must not be able to
 * read it as one — the audit's whole premise was a turn reporting work that had not happened.
 * These drive the real handler the runtime dispatches to.
 */

function ctxFor(events: Array<Record<string, unknown>>, applied: unknown) {
  const finished: unknown[] = [];
  const ctx = {
    deps: {
      connector: {
        execute: async function* () {
          for (const e of events) yield e;
        },
      },
      events: { append: async () => undefined },
    },
    run: { id: "run-1", spaceId: "space-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    context: {},
  };
  const call = {
    name: "COMPOSIO_SEARCH_TOOLS",
    args: { query: "send email" },
    effectKey: "key-1",
    connectorCall: { tool: "COMPOSIO_SEARCH_TOOLS", args: {}, executionId: "exec-1" },
    applied,
    finish: (r: unknown) => {
      finished.push(r);
      return r;
    },
  };
  return { ctx, call, finished };
}

describe("a connector result says which layer it reached", () => {
  it("marks a catalog search as discovered, with no effect and no execution claim", async () => {
    const f = ctxFor(
      [{ type: "result", data: { tools: [{ slug: "GMAIL_SEND_EMAIL" }] } }],
      undefined,
    );
    const result = (await connectorTool(f.ctx as never, f.call as never)) as Record<
      string,
      unknown
    >;
    expect(result.route).toMatchObject({ layer: "tool", kind: "discovered", executed: false });
    expect(result.route).toMatchObject({ effectId: null });
    expect(String(result.routeNotice)).toContain("还没有执行");
  });

  it("refuses to call a search executed even when it somehow has an effect id", async () => {
    // Belt and braces: the classifier is what decides, not the caller's bookkeeping.
    const f = ctxFor([{ type: "result", data: { tools: [] } }], { effect: { id: "effect-9" } });
    const result = (await connectorTool(f.ctx as never, f.call as never)) as Record<
      string,
      unknown
    >;
    expect(result.route).toMatchObject({ executed: false, effectId: null });
  });

  it("leaves an ordinary action's own result alone", async () => {
    // A real action's payload is what the model needs; adding a marker to every connector result
    // would change a payload the product reads everywhere for no gain.
    const f = ctxFor([{ type: "result", data: { messageId: "m-1" } }], {
      effect: { id: "effect-1" },
    });
    f.call.name = "GMAIL_SEND_EMAIL";
    const result = (await connectorTool(f.ctx as never, f.call as never)) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ messageId: "m-1" });
    expect(result).not.toHaveProperty("route");
  });
});
