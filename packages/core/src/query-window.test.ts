import { describe, expect, it } from "vitest";
import { promptStatesPeriod, windowWasDefaulted } from "./query-window.js";

/**
 * The server decides whether the period came from the person.
 *
 * The audit's answer defaulted to a week the user never named and reported prices
 * for it. Trusting the model to disclose that puts the check in the hands of the
 * party that made the choice, so the decision is made from what the person actually
 * wrote. The rule is deliberately blunt: a stated period means no assumption was
 * needed, and anything else means one was.
 */

describe("promptStatesPeriod", () => {
  it("recognises a date the person typed", () => {
    expect(promptStatesPeriod("flights on 2026-11-09")).toBe(true);
    expect(promptStatesPeriod("flights on 11/9")).toBe(true);
    expect(promptStatesPeriod("11月9日的航班")).toBe(true);
    expect(promptStatesPeriod("flights in November")).toBe(true);
  });

  it("recognises a relative period", () => {
    expect(promptStatesPeriod("next week New York to Tokyo")).toBe(true);
    expect(promptStatesPeriod("下周纽约到东京")).toBe(true);
    expect(promptStatesPeriod("last quarter's revenue")).toBe(true);
    expect(promptStatesPeriod("this year so far")).toBe(true);
  });

  it("says no when nothing bounds the question", () => {
    expect(promptStatesPeriod("how many orders did we get")).toBe(false);
    expect(promptStatesPeriod("show me the pipeline")).toBe(false);
    expect(promptStatesPeriod("")).toBe(false);
    expect(promptStatesPeriod(undefined)).toBe(false);
  });

  it("does not treat a number that is not a date as one", () => {
    // A quantity must not be mistaken for a period.
    expect(promptStatesPeriod("how many units did we sell")).toBe(false);
  });
});

describe("windowWasDefaulted", () => {
  it("accepts the model's own admission", () => {
    expect(windowWasDefaulted({ claimedByModel: true, userPrompt: "anything" })).toBe(true);
  });

  it("overrides a claim of choice when the person named no period", () => {
    // This is the audit's case: the answer presented an assumed week as the basis.
    expect(windowWasDefaulted({ claimedByModel: false, userPrompt: "show me sales" })).toBe(true);
  });

  it("accepts a claim of choice when the person really named the period", () => {
    expect(
      windowWasDefaulted({ claimedByModel: false, userPrompt: "sales for last quarter" }),
    ).toBe(false);
  });
});
