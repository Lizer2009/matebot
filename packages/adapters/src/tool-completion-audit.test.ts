import type { AgentToolCompletion } from "@matebot/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  reachableDestinationOf,
  reachableHostOf,
  toolCompletionAuditPayload,
} from "./tool-completion-audit.js";
import { EgressRefusedError } from "./network-address.js";
import { classifyToolFailure } from "./tool-failure.js";

/**
 * Enough to trace where a run went, and nothing that could leak.
 *
 * The audit could see which tool ran and whether it failed, but not what page it
 * opened — so a session that visited a product documentation path could not be
 * traced to that path at all. Recording only the host was too little; recording the
 * URL would be too much, because a query string carries search phrases, tokens and
 * addresses.
 *
 * A word-like shape is *not* evidence of safety: `/users/alex` and `/users/ada` are
 * equally word-like, and a short token looks exactly like a section name. So the
 * path is kept only when something vouches for it — the page is in the closed set
 * this build ships, or the caller declared the route — and is otherwise withheld
 * with a marker saying so.
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

  /**
   * The cases the earlier rule got wrong. Each is a path a person, a document or a
   * token could be identified by, and each looks like ordinary words.
   */
  it.each([
    ["a person's name", "https://example.test/users/alex"],
    ["a short opaque path token", "https://example.test/s/9f8b7c6d"],
    ["a section with a word-like slug", "https://example.test/files/report"],
  ])("withholds %s on a site this build does not own", (_label, url) => {
    const dest = reachableDestinationOf({ url });
    expect(dest?.path).toBeUndefined();
    expect(dest?.pathWithheld).toBe("unrecognised");
    // The origin is still recorded, so the site is traceable without the page.
    expect(dest?.origin).toBe("https://example.test");
  });

  it("withholds a long private document slug, flagged as credential-shaped", () => {
    // Long hyphenated slugs are exactly what a shared document link looks like, so
    // they are called out rather than merely omitted.
    const dest = reachableDestinationOf({
      url: "https://example.test/notes/quarterly-plan-draft",
    });
    expect(dest?.path).toBeUndefined();
    expect(dest?.pathWithheld).toBe("credential_shaped");
  });

  it("keeps a path that matches a declared low-risk route", () => {
    const dest = reachableDestinationOf({ url: "https://example.test/status/incidents" }, [], [
      { prefix: "/status/", staticSegments: ["incidents"] },
    ]);
    expect(dest?.path).toBe("/status/incidents");
  });

  it("does not let a declared prefix carry an undeclared segment", () => {
    const dest = reachableDestinationOf({ url: "https://example.test/status/alex" }, [], [
      { prefix: "/status/", staticSegments: ["incidents"] },
    ]);
    expect(dest?.path).toBeUndefined();
    expect(dest?.pathWithheld).toBe("unrecognised");
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

  it("withholds a very long path", () => {
    const dest = reachableDestinationOf({ url: `https://example.test/${"a/".repeat(150)}` });
    expect(dest?.pathWithheld).toBe("too_long");
  });

  it("withholds the path of a documented page fetched from a site that does not host it", () => {
    // The allow list is a set of full pages, not a path pattern to replay anywhere.
    const dest = reachableDestinationOf(
      { url: "https://elsewhere.example.test/docs/integrations/" },
      DOCS,
    );
    expect(dest?.path).toBeUndefined();
    expect(dest?.pathWithheld).toBe("unrecognised");
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

  it("returns nothing when there is no usable URL", () => {
    expect(reachableDestinationOf({ query: "flights" })).toBeUndefined();
    expect(reachableDestinationOf({ url: "not a url" })).toBeUndefined();
    // A non-HTTP scheme is not a destination a network tool went to.
    expect(reachableDestinationOf({ url: "file:///etc/passwd" })).toBeUndefined();
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
      destination: {
        host: "docs.example.test",
        origin: "https://docs.example.test",
        path: "/docs/integrations/",
      },
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
    expect(payload.destination).toEqual({
      host: "example.test",
      origin: "https://example.test",
      pathWithheld: "credential_shaped",
    });
  });

  it("omits the destination for a tool that has none", () => {
    const payload = toolCompletionAuditPayload({ ...base, destination: undefined });
    expect(payload).not.toHaveProperty("destination");
  });

  it("redacts a secret that appears in the recorded destination", () => {
    const payload = toolCompletionAuditPayload(
      { ...base, destination: { ...base.destination!, host: "abc123.example.test" } },
      ["abc123"],
    );
    expect(JSON.stringify(payload)).not.toContain("abc123");
  });

  /**
   * The audit needs to join a request to its completion, and needs the completion
   * to say what went wrong. Both are recorded, and neither carries a credential.
   */
  it("classifies a failure without carrying a credential", () => {
    const payload = toolCompletionAuditPayload(
      { ...base, error: "request failed with key redacted-key-abc123" },
      ["redacted-key-abc123"],
    );
    expect(payload.outcome).toBe("error");
    expect(JSON.stringify(payload)).not.toContain("redacted-key-abc123");
    // The class is present even when the message tells the classifier nothing.
    expect(payload.failure).toEqual({ class: "unknown" });
    expect(payload.destination).toMatchObject({ path: "/docs/integrations/" });
  });

  it("reads a failure from an error result, not only from completion.error", () => {
    // Tools report failures by returning `{ error }` too, and Pi keeps that in
    // details without filling completion.error. Both paths must classify.
    const payload = toolCompletionAuditPayload({
      ...base,
      result: {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "nope" }],
        details: { error: Object.assign(new Error("forbidden"), { status: 403 }) },
      },
    });
    expect(payload.outcome).toBe("error");
    expect(payload.failure).toEqual({ class: "auth_required", detail: "http_403" });
  });

  it("reads a failure from an isError result as well", () => {
    const payload = toolCompletionAuditPayload({
      ...base,
      result: {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "the server refused" }],
        details: { isError: true, content: [{ type: "text", text: "the server refused" }] },
      },
    });
    expect(payload.outcome).toBe("error");
    expect(payload.failure).toEqual({ class: "unknown" });
  });

  it("is paused, not failed, when the call is waiting for the person", () => {
    const payload = toolCompletionAuditPayload({
      ...base,
      paused: true,
      result: { error: "waiting" } as never,
    });
    expect(payload.outcome).toBe("paused");
  });
});

/**
 * The class must come from structure first. A provider rewords a message freely; a
 * status code or an error class does not move.
 */
describe("classifyToolFailure", () => {
  it("recognises our own egress refusal ahead of any network reading", () => {
    const refusal = new EgressRefusedError("10.0.0.5", "URL resolves to a private address");
    expect(classifyToolFailure(refusal)).toEqual({
      class: "security_refused",
      detail: "URL resolves to a private address",
    });
  });

  it.each([
    ["ECONNREFUSED", undefined, "network_error"],
    ["ENOTFOUND", undefined, "network_error"],
    ["ETIMEDOUT", undefined, "timeout"],
    ["SECRET_STORE_UNAVAILABLE", undefined, "credential_unavailable"],
    ["SECRET_NOT_FOUND", undefined, "auth_required"],
    ["SANDBOX_RATE_LIMIT", undefined, "rate_limited"],
    ["EGRESS_REFUSED", undefined, "security_refused"],
    [undefined, 401, "auth_required"],
    [undefined, 403, "auth_required"],
    [undefined, 429, "rate_limited"],
    [undefined, 503, "provider_unavailable"],
  ] as const)("classifies code %s and status %s", (code, status, expected) => {
    const error = Object.assign(new Error("reworded by the provider"), { code, status });
    expect(classifyToolFailure(error).class).toBe(expected);
  });

  it("follows a cause to find the structured fact", () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const outer = new Error("fetch failed", { cause: inner });
    expect(classifyToolFailure(outer)).toEqual({ class: "network_error", detail: "ECONNRESET" });
  });

  it("never turns a refusal into a network error, whatever the message says", () => {
    const refusal = Object.assign(new EgressRefusedError("x.example.test", "refused"), {
      code: "ENOTFOUND",
      message: "getaddrinfo ENOTFOUND x.example.test",
    });
    expect(classifyToolFailure(refusal).class).toBe("security_refused");
  });

  it("does not read a security decision out of prose alone", () => {
    // A message that merely mentions a private address is not a policy refusal:
    // nothing structured says it was refused, so it is not classified as one.
    expect(
      classifyToolFailure(new Error("URL resolves to a private address")).class,
    ).not.toBe("security_refused");
  });

  it("keeps an unresolved host distinct from a refused one", () => {
    expect(classifyToolFailure(new Error("URL did not resolve to any address"))).toEqual({
      class: "network_error",
      detail: "unresolved",
    });
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classifyToolFailure(new Error("something went sideways"))).toEqual({ class: "unknown" });
    expect(classifyToolFailure(undefined)).toEqual({ class: "unknown" });
  });
});
