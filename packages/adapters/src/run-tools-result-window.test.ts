import { describe, expect, it } from "vitest";
import { surfaceFromArgs } from "./run-tools-result.js";

/**
 * The server, not the model, decides whether a result's period was assumed.
 *
 * The audit's answer defaulted to a week the user never named and reported figures
 * for it. A flag the model sets is not a check: the party that made the choice
 * would be the party confirming it. So the tool reads what the person actually
 * asked, and there are three outcomes rather than two:
 *
 * - they named a period: the card is theirs, nothing is added;
 * - the model says it chose: the card is published and both the card and the
 *   reply say the dates were assumed;
 * - nobody said anything: the turn asks, and no figure is published.
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
  it("is refused when the person named no period and the model did not say it chose one", async () => {
    // The audit's exact failure: a window nobody asked for, presented as the basis
    // of the search. There is no card, because there is nothing true to label.
    const built = await surfaceFromArgs(
      { ...args, defaultedWindow: false },
      deps("show me the sales numbers"),
    );
    expect(built).toEqual({ ok: false, error: "unstated_window" });
  });

  it("is published and marked when the model admits choosing it", async () => {
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

  it("is refused when there is no prompt to check against", async () => {
    // A run with no user prompt cannot support a claim that the dates were asked
    // for, so the conservative answer wins.
    const built = await surfaceFromArgs({ ...args, defaultedWindow: false }, deps(null));
    expect(built).toEqual({ ok: false, error: "unstated_window" });
  });

  it("says so on the card's provenance line", async () => {
    const built = await surfaceFromArgs({ ...args }, deps("what were the sales"));
    // Nobody stated a period here either, so this is a refusal rather than a card…
    expect(built).toEqual({ ok: false, error: "unstated_window" });
    // …and an admitted default is what produces the labelled line.
    const admitted = await surfaceFromArgs(
      { ...args, defaultedWindow: true },
      deps("what were the sales"),
    );
    if (!admitted.ok) throw new Error(admitted.error);
    const { provenanceLine } = await import("@matebot/core");
    expect(provenanceLine(admitted.surface.provenance)).toContain("dates assumed");
  });
});

describe("the reply the server writes for a published result", () => {
  it("states the assumption itself instead of leaving it to the model", async () => {
    const { resultReplyText } = await import("./run-tools-result.js");
    expect(resultReplyText({ empty: false, provenance: { defaultedWindow: true } })).toContain(
      "默认范围",
    );
    expect(resultReplyText({ empty: false, provenance: {} })).not.toContain("默认");
    expect(resultReplyText({ empty: true, provenance: { defaultedWindow: true } })).toContain(
      "没有查到",
    );
  });
});
