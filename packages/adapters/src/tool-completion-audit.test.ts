import type { AgentToolCompletion } from "@matebot/adapter-kit";
import { describe, expect, it } from "vitest";
import { reachableHostOf, toolCompletionAuditPayload } from "./tool-completion-audit.js";

/**
 * Enough to trace where a run went, and nothing that could leak.
 *
 * The audit could see which tool ran and whether it failed, but not what site it
 * touched, so a session that opened a product documentation page could not be
 * traced to an address. The host answers that. The path, the query, the scheme and
 * any credential are deliberately absent — a search phrase or a token in a query
 * string is exactly what must never reach a log.
 */

describe("reachableHostOf", () => {
  it("keeps only the host", () => {
    expect(reachableHostOf({ url: "https://docs.example.test/a/b?q=private+phrase" })).toBe(
      "docs.example.test",
    );
  });

  it("reads the common argument names", () => {
    expect(reachableHostOf({ endpoint: "https://api.example.test/mcp" })).toBe("api.example.test");
    expect(reachableHostOf({ href: "https://a.example.test/x" })).toBe("a.example.test");
  });

  it("lowercases the host so one site is one value", () => {
    expect(reachableHostOf({ url: "https://Docs.Example.TEST/x" })).toBe("docs.example.test");
  });

  it("returns nothing when there is no URL", () => {
    expect(reachableHostOf({ query: "flights" })).toBeUndefined();
    expect(reachableHostOf({ url: "not a url" })).toBeUndefined();
    expect(reachableHostOf({ url: 42 })).toBeUndefined();
  });

  it("never yields the path, the query or userinfo", () => {
    const host = reachableHostOf({ url: "https://user:pass@site.example.test/secret?token=abc" });
    expect(host).toBe("site.example.test");
    expect(JSON.stringify(host)).not.toContain("secret");
    expect(JSON.stringify(host)).not.toContain("token");
    expect(JSON.stringify(host)).not.toContain("pass");
  });
});

describe("toolCompletionAuditPayload", () => {
  const base: AgentToolCompletion = {
    name: "web_fetch",
    executionId: "run-1:web_fetch:0",
    durationMs: 12,
    host: "docs.example.test",
  };

  it("records the host and the correlation ids a reader needs", () => {
    const payload = toolCompletionAuditPayload(base);
    expect(payload).toMatchObject({
      name: "web_fetch",
      executionId: "run-1:web_fetch:0",
      durationMs: 12,
      outcome: "succeeded",
      host: "docs.example.test",
    });
  });

  it("omits the host for a tool that has none", () => {
    const payload = toolCompletionAuditPayload({ ...base, host: undefined });
    expect(payload).not.toHaveProperty("host");
  });

  it("redacts a host that contains a secret value", () => {
    const payload = toolCompletionAuditPayload({ ...base, host: "abc123.example.test" }, [
      "abc123",
    ]);
    expect(JSON.stringify(payload)).not.toContain("abc123");
  });

  it("classifies a failure without carrying a credential", () => {
    const payload = toolCompletionAuditPayload(
      { ...base, error: "request failed with key sk_live_abc123" },
      ["sk_live_abc123"],
    );
    expect(payload.outcome).toBe("error");
    expect(JSON.stringify(payload)).not.toContain("sk_live_abc123");
    expect(payload.host).toBe("docs.example.test");
  });
});
