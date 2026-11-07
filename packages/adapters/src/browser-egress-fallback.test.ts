import { describe, expect, it, vi } from "vitest";
import { browserNavigateFromTool, EGRESS_REFUSED_HOST_MESSAGE } from "./browser-tools.js";
import {
  EGRESS_REFUSED_SHELL_MESSAGE,
  refuseRefusedDestinationShell,
} from "./egress-fallback-guard.js";
import { egressRefused, withEgressRefusalLedger } from "./network-address.js";

/**
 * A refusal is about a destination, not about one tool and not about one spelling.
 *
 * The audit saw a fetcher refuse a host and the run then reach the same place two
 * other ways: through the browser, and through shell. Both are covered here at the
 * point the call would run. What is *not* covered is stated in the plan: a command
 * that builds its destination at run time, and a click inside a page that already
 * navigates on its own, never name a host the server can read.
 */

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return { ...actual, recordSecurityEvent: vi.fn(async () => undefined) };
});

const computer = { id: "computer-1" } as never;
const context = { signal: new AbortController().signal } as never;

function browser() {
  const navigate = vi.fn(async () => ({ url: "https://example.test/", snapshot: "ok" }));
  return { navigate, provider: { navigate } as never };
}

async function refused(host: string): Promise<Set<string>> {
  const ledger = new Set<string>();
  await withEgressRefusalLedger(ledger, async () => {
    egressRefused(host, new Error("URL resolves to a private address"));
  });
  return ledger;
}

describe("the refusal ledger covers the browser", () => {
  it("refuses navigation to a host a fetch was told to stay away from", async () => {
    const ledger = await refused("blocked.example.test");
    const { provider, navigate } = browser();

    const result = (await withEgressRefusalLedger(ledger, async () =>
      browserNavigateFromTool(provider, computer, context, {
        url: "https://blocked.example.test/x",
      }),
    )) as { ok?: boolean; error?: string; uncertain?: boolean };

    expect(result.error).toBe(EGRESS_REFUSED_HOST_MESSAGE);
    // Nothing ran, so the model fixes the call instead of turning to desktop tools.
    expect(result.uncertain).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("still navigates to a host that was never refused", async () => {
    const ledger = await refused("blocked.example.test");
    const { provider, navigate } = browser();

    await withEgressRefusalLedger(ledger, async () =>
      browserNavigateFromTool(provider, computer, context, {
        url: "https://allowed.example.test/",
      }),
    );

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  /**
   * One destination has many spellings. A refusal that only remembered the exact
   * string it was handed could be routed around by writing the same place another
   * way — which is precisely what a model trying again would do.
   */
  it.each([
    ["a trailing root dot", "blocked.example.test.", "https://blocked.example.test/"],
    ["a capitalised host", "BLOCKED.example.test", "https://blocked.example.test/"],
    ["a compressed IPv6 address", "[::1]", "http://[0:0:0:0:0:0:0:1]/"],
    ["an IPv4-mapped IPv6 address", "[::ffff:127.0.0.1]", "http://127.0.0.1/"],
    ["a written-out loopback", "127.0.0.1", "http://127.1/"],
  ])("refuses the same destination written as %s", async (_label, refusedHost, url) => {
    const ledger = await refused(refusedHost);
    const { provider, navigate } = browser();

    const result = (await withEgressRefusalLedger(ledger, async () =>
      browserNavigateFromTool(provider, computer, context, { url }),
    )) as { error?: string };

    expect(result.error).toBe(EGRESS_REFUSED_HOST_MESSAGE);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps concurrent runs' refusals apart", async () => {
    const first = new Set<string>();
    const second = new Set<string>();
    const { provider, navigate } = browser();

    await Promise.all([
      withEgressRefusalLedger(first, async () => {
        egressRefused("only-in-first.example.test", new Error("private"));
      }),
      withEgressRefusalLedger(second, async () => {
        egressRefused("only-in-second.example.test", new Error("private"));
      }),
    ]);

    expect(first.size).toBe(1);
    expect(second.size).toBe(1);

    // A host refused in one run is not refused in the other.
    await withEgressRefusalLedger(second, async () =>
      browserNavigateFromTool(provider, computer, context, {
        url: "https://only-in-first.example.test/",
      }),
    );
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("the refusal ledger covers shell", () => {
  it("turns down a command that names the refused host", async () => {
    const ledger = await refused("blocked.example.test");
    const result = refuseRefusedDestinationShell(ledger, {
      command: "curl -sS https://blocked.example.test/data",
    });
    expect(result).toEqual({ error: EGRESS_REFUSED_SHELL_MESSAGE });
  });

  it("reads a host written without a scheme or with a port", async () => {
    const ledger = await refused("10.1.2.3");
    expect(refuseRefusedDestinationShell(ledger, { command: "nc 10.1.2.3 8080" })).toEqual({
      error: EGRESS_REFUSED_SHELL_MESSAGE,
    });
  });

  /**
   * The shell check must normalise the way a real client does.
   *
   * `127.1` and `2130706433` both reach `127.0.0.1`; a check that compared the
   * written text alone would be bypassed by spelling the address differently, which
   * is exactly what the browser guard was fixed for.
   */
  it.each([
    ["a short loopback form", "127.0.0.1", "curl -sS http://127.1/x"],
    ["a single-integer loopback", "127.0.0.1", "curl -sS http://2130706433/x"],
    ["localhost by name", "127.0.0.1", "curl -sS http://localhost:3000/admin"],
    ["compressed IPv6 loopback", "127.0.0.1", "curl -sS 'http://[::1]:3000/admin'"],
    ["an expanded IPv6 loopback", "[::1]", "curl -sS http://0:0:0:0:0:0:0:1/"],
  ])("refuses %s however it is written", async (_label, refusedHost, command) => {
    const ledger = await refused(refusedHost);
    expect(refuseRefusedDestinationShell(ledger, { command })).toEqual({
      error: EGRESS_REFUSED_SHELL_MESSAGE,
    });
  });

  it("still allows a different host that merely looks similar", async () => {
    const ledger = await refused("10.1.2.3");
    // A different address, a version string and a file name are not the refusal.
    expect(refuseRefusedDestinationShell(ledger, { command: "nc 10.1.2.4 8080" })).toBeUndefined();
    expect(
      refuseRefusedDestinationShell(ledger, { command: "python3 -c 'print(3.10.2)'" }),
    ).toBeUndefined();
  });

  it("leaves an ordinary command that names no refused host alone", async () => {
    const ledger = await refused("blocked.example.test");
    // A version string, a file name and a public host are not the refused place.
    expect(
      refuseRefusedDestinationShell(ledger, {
        command: "python3 -c 'print(1.2.3)' && unzip report.example.zip && curl https://ok.test/",
      }),
    ).toBeUndefined();
  });

  it("does not touch a run with no refusals", async () => {
    expect(
      refuseRefusedDestinationShell(new Set(), { command: "curl https://blocked.example.test/" }),
    ).toBeUndefined();
    expect(
      refuseRefusedDestinationShell(undefined, { command: "curl https://blocked.example.test/" }),
    ).toBeUndefined();
  });

  it("does not refuse a different run's destination", async () => {
    const ledger = await refused("blocked.example.test");
    expect(
      refuseRefusedDestinationShell(ledger, { command: "curl https://other.example.test/" }),
    ).toBeUndefined();
  });

  /**
   * What this barrier cannot see, asserted so the limit is a fact rather than a
   * claim: the address is assembled when the command runs, so no literal appears in
   * the text the server reads.
   */
  it("cannot see a destination the command builds at run time", async () => {
    const ledger = await refused("blocked.example.test");
    expect(
      refuseRefusedDestinationShell(ledger, {
        command: 'curl "https://$(printf blocked).example.test/"',
      }),
    ).toBeUndefined();
  });
});
