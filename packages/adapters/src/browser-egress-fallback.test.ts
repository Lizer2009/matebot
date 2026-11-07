import { describe, expect, it, vi } from "vitest";
import { browserNavigateFromTool, EGRESS_REFUSED_HOST_MESSAGE } from "./browser-tools.js";
import { egressRefused, withEgressRefusalLedger } from "./network-address.js";

/**
 * A refusal is about a destination, not about one tool.
 *
 * The audit saw the fetcher refuse a host and the browser then visit it. Whether
 * the browser could actually reach it is a runtime question, but the product must
 * not present the refusal as advisory: once this run's guard has declined a host,
 * navigating to it is refused too, with a settled result that changes nothing.
 */

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return { ...actual, recordSecurityEvent: vi.fn(async () => undefined) };
});

function browser() {
  const navigate = vi.fn(async () => ({ url: "https://example.test/", snapshot: "ok" }));
  return { navigate, provider: { navigate } as never };
}

const computer = { id: "computer-1" } as never;
const context = { signal: new AbortController().signal } as never;

describe("a refused host cannot be reached through the browser", () => {
  it("records a refusal in the run's ledger and refuses navigation to it", async () => {
    const ledger = new Set<string>();
    const { provider, navigate } = browser();

    await withEgressRefusalLedger(ledger, async () => {
      // A fetch tool hits the guard.
      egressRefused("blocked.example.test", new Error("URL resolves to a private address"));
    });

    expect([...ledger]).toEqual(["blocked.example.test"]);

    const result = (await withEgressRefusalLedger(ledger, async () =>
      browserNavigateFromTool(provider, computer, context, {
        url: "https://blocked.example.test/x",
      }),
    )) as { ok?: boolean; error?: string; uncertain?: boolean };

    expect(result.ok).toBe(false);
    expect(result.error).toBe(EGRESS_REFUSED_HOST_MESSAGE);
    // Nothing ran, so the model fixes the call instead of trying desktop tools.
    expect(result.uncertain).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("still navigates to a host that was never refused", async () => {
    const ledger = new Set<string>();
    const { provider, navigate } = browser();

    await withEgressRefusalLedger(ledger, async () => {
      egressRefused("blocked.example.test", new Error("URL resolves to a private address"));
    });
    await withEgressRefusalLedger(ledger, async () =>
      browserNavigateFromTool(provider, computer, context, {
        url: "https://allowed.example.test/",
      }),
    );

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("matches the host case-insensitively", async () => {
    const ledger = new Set(["blocked.example.test"]);
    const { provider, navigate } = browser();
    const result = (await withEgressRefusalLedger(ledger, async () =>
      browserNavigateFromTool(provider, computer, context, {
        url: "https://BLOCKED.Example.test/x",
      }),
    )) as { ok?: boolean; error?: string };

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

    expect([...first]).toEqual(["only-in-first.example.test"]);
    expect([...second]).toEqual(["only-in-second.example.test"]);

    // A host refused in one run is not refused in the other.
    await withEgressRefusalLedger(second, async () =>
      browserNavigateFromTool(provider, computer, context, {
        url: "https://only-in-first.example.test/",
      }),
    );
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
