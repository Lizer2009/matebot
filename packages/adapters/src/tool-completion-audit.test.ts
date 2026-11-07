import type { AgentToolCompletion } from "@matebot/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  reachableDestinationOf,
  reachableHostOf,
  toolCompletionAuditPayload,
} from "./tool-completion-audit.js";

/**
 * Enough to trace where a run went, and nothing that could leak.
 *
 * The audit could see which tool ran and whether it failed, but not what page it
 * opened — so a session that visited a product documentation path could not be
 * traced to that path at all. Recording only the host was too little; recording the
 * URL would be too much, because a query string carries search phrases, tokens and
 * addresses. The rule here is: keep the origin, keep a path only when it is safe,
 * and say when it was withheld.
 */

const DOCS = ["https://docs.example.test/docs/integrations/"];

describe("reachableDestinationOf", () => {
  it("records the path of a documentation page this build ships", () => {
    expect(
      reachableDestinationOf({ url: "https://docs.example.test/docs/integrations/" }, DOCS),
    ).toEqual({
      host: "docs.example.test",
      origin: "https://docs.example.test",
      path: "/docs/integrations/",
    });
  });

  it("never records a query, fragment or userinfo", () => {
    const dest = reachableDestinationOf(
      { url: "https://user:pass@docs.example.test/docs/integrations/?q=private#frag" },
      DOCS,
    );
    const serialized = JSON.stringify(dest);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("pass");
    expect(serialized).not.toContain("frag");
    expect(dest?.path).toBe("/docs/integrations/");
  });

  it("keeps a plainly word-like path on any site", () => {
    expect(reachableDestinationOf({ url: "https://www.example.test/flights/search" })).toEqual({
      host: "www.example.test",
      origin: "https://www.example.test",
      path: "/flights/search",
    });
  });

  it("withholds a path that looks like a credential", () => {
    const dest = reachableDestinationOf({
      url: "https://example.test/api/placeholder-token-value-1234",
    });
    expect(dest?.path).toBeUndefined();
    expect(dest?.pathWithheld).toBe("credential_shaped");
    expect(JSON.stringify(dest)).not.toContain("placeholder-token");
  });

  it("withholds a long opaque identifier rather than guessing it is safe", () => {
    const dest = reachableDestinationOf({
      url: "https://example.test/files/9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
    });
    expect(dest?.pathWithheld).toBe("credential_shaped");
  });

  it("withholds a path containing an email address", () => {
    const dest = reachableDestinationOf({ url: "https://example.test/u/alex@example.test" });
    expect(dest?.pathWithheld).toBe("credential_shaped");
    expect(JSON.stringify(dest)).not.toContain("alex@");
  });

  it("withholds an unrecognised shape such as a search path segment with a space", () => {
    const dest = reachableDestinationOf({ url: "https://example.test/search/hello%20world" });
    expect(dest?.pathWithheld).toBe("unrecognised");
  });

  it("withholds a very long path", () => {
    const dest = reachableDestinationOf({ url: `https://example.test/${"a/".repeat(150)}` });
    expect(dest?.pathWithheld).toBe("too_long");
  });

  it("still reports the origin when the path is withheld", () => {
    const dest = reachableDestinationOf({ url: "https://example.test/api/placeholder-token-abc123" });
    expect(dest?.origin).toBe("https://example.test");
    expect(dest?.host).toBe("example.test");
  });

  it("distinguishes two ports on one host", () => {
    expect(reachableDestinationOf({ url: "http://127.0.0.1:8080/a" })?.origin).toBe(
      "http://127.0.0.1:8080",
    );
    expect(reachableDestinationOf({ url: "http://127.0.0.1:9090/a" })?.origin).toBe(
      "http://127.0.0.1:9090",
    );
  });

  it("returns nothing when there is no URL", () => {
    expect(reachableDestinationOf({ query: "flights" })).toBeUndefined();
    expect(reachableDestinationOf({ url: "not a url" })).toBeUndefined();
  });
});

describe("reachableHostOf", () => {
  it("still yields just the host for callers that want it", () => {
    expect(reachableHostOf({ url: "https://Docs.Example.TEST/x?y=1" })).toBe("docs.example.test");
  });
});

describe("toolCompletionAuditPayload", () => {
  const base: AgentToolCompletion = {
    name: "web_fetch",
    executionId: "run-1:web_fetch:0",
    durationMs: 12,
    destination: {
      host: "docs.example.test",
      origin: "https://docs.example.test",
      path: "/docs/integrations/",
    },
  };

  it("records run-scoped correlation ids, the tool, and where it went", () => {
    expect(toolCompletionAuditPayload(base)).toMatchObject({
      name: "web_fetch",
      executionId: "run-1:web_fetch:0",
      durationMs: 12,
      outcome: "succeeded",
      host: "docs.example.test",
      origin: "https://docs.example.test",
      path: "/docs/integrations/",
    });
  });

  it("marks a withheld path instead of omitting it silently", () => {
    const payload = toolCompletionAuditPayload({
      ...base,
      destination: {
        host: "example.test",
        origin: "https://example.test",
        pathWithheld: "credential_shaped",
      },
    });
    expect(payload).not.toHaveProperty("path");
    expect(payload.pathWithheld).toBe("credential_shaped");
  });

  it("omits the destination for a tool that has none", () => {
    const payload = toolCompletionAuditPayload({ ...base, destination: undefined });
    expect(payload).not.toHaveProperty("host");
    expect(payload).not.toHaveProperty("origin");
  });

  it("redacts a secret that appears in the recorded destination", () => {
    const payload = toolCompletionAuditPayload(
      { ...base, destination: { ...base.destination!, host: "abc123.example.test" } },
      ["abc123"],
    );
    expect(JSON.stringify(payload)).not.toContain("abc123");
  });

  it("classifies a failure without carrying a credential", () => {
    const payload = toolCompletionAuditPayload(
      { ...base, error: "request failed with key redacted-key-abc123" },
      ["redacted-key-abc123"],
    );
    expect(payload.outcome).toBe("error");
    expect(JSON.stringify(payload)).not.toContain("redacted-key-abc123");
    expect(payload.path).toBe("/docs/integrations/");
  });
});
