import { describe, expect, it } from "vitest";
import { surfaceFromArgs } from "./run-tools-result.js";

/**
 * The server, not the model, decides whether a result's period was assumed.
 *
 * The audit's answer defaulted to a week the user never named and reported figures
 * for it. A flag the model sets is not a check: the party that made the choice
 * would be the party confirming it. So the tool reads what the person actually
 * asked, and a claim of "these are your dates" is overridden when their words
 * contain no period at all.
 */

const deps = (userPrompt: string | null) => ({
  connectionFor: async () => null,
  userPrompt,
  csvRead: async () => ({
    ok: true as const,
    rows: [{ quarter: "Q1", amount: 10 }],
    asOf: "2026-11-07T00:00:00Z",
    sourceLabel: "Upload: q1.csv",
  }),
});

const args = {
  title: "Sales",
  sourceId: "csv-upload",
  from: "2026-11-09",
  to: "2026-11-16",
} as const;

async function provenance(extra: Record<string, unknown>, userPrompt: string | null) {
  const built = await surfaceFromArgs({ ...args, ...extra }, deps(userPrompt));
  if (!built.ok) throw new Error(built.error);
  return built.surface.provenance;
}

describe("a period the assistant chose", () => {
  it("is marked when the person named no period, even if the model claimed otherwise", async () => {
    const mark = await provenance({ defaultedWindow: false }, "show me the sales numbers");
    expect(mark.defaultedWindow).toBe(true);
  });

  it("is marked when the model admits it", async () => {
    const mark = await provenance({ defaultedWindow: true }, "sales for last quarter");
    expect(mark.defaultedWindow).toBe(true);
  });

  it("is not marked when the person did name the period", async () => {
    const mark = await provenance({}, "sales for last quarter");
    expect(mark.defaultedWindow).toBeUndefined();
  });

  it("is not marked when the person gave exact dates", async () => {
    const mark = await provenance({}, "sales from 2026-11-09 to 2026-11-16");
    expect(mark.defaultedWindow).toBeUndefined();
  });

  it("is marked when there is no prompt to check against", async () => {
    // A run with no user prompt cannot support a claim that the dates were asked
    // for, so the conservative answer wins.
    const mark = await provenance({ defaultedWindow: false }, null);
    expect(mark.defaultedWindow).toBe(true);
  });

  it("says so on the card's provenance line", async () => {
    const built = await surfaceFromArgs({ ...args }, deps("what were the sales"));
    if (!built.ok) throw new Error(built.error);
    // The line under the card carries the assumption, not only the reply.
    const { provenanceLine } = await import("@matebot/core");
    expect(provenanceLine(built.surface.provenance)).toContain("dates assumed");
  });
});
