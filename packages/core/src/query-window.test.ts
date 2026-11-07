import { describe, expect, it } from "vitest";
import { promptStatesPeriod, windowDecision, windowNeedsAsking } from "./query-window.js";

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

describe("what the server can say about a window", () => {
  it("is the person's when they stated a period", () => {
    expect(windowDecision({ claimedByModel: false, userPrompt: "sales last quarter" })).toBe(
      "stated",
    );
  });

  it("accepts the model's own admission, even beside a stated period", () => {
    expect(windowDecision({ claimedByModel: true, userPrompt: "anything" })).toBe("assumed");
    expect(windowDecision({ claimedByModel: true, userPrompt: "sales last quarter" })).toBe(
      "assumed",
    );
  });

  it("is unstated when a model that did not admit a choice names a window anyway", () => {
    // The audit's case: an assumed week presented as the basis of the answer.
    expect(windowDecision({ claimedByModel: false, userPrompt: "show me sales" })).toBe("unstated");
  });

  it("is an admission the model made, even if the person also named a period", () => {
    // Saying "I chose these dates" is the safe direction and is never overridden.
    expect(windowDecision({ claimedByModel: true, userPrompt: "sales last quarter" })).toBe(
      "assumed",
    );
  });

  it("is unstated when nobody said, which is neither labelled nor published", () => {
    expect(windowDecision({ claimedByModel: false, userPrompt: "show me sales" })).toBe("unstated");
    expect(windowNeedsAsking({ claimedByModel: false, userPrompt: "show me sales" })).toBe(true);
    expect(windowNeedsAsking({ claimedByModel: true, userPrompt: "show me sales" })).toBe(false);
  });
});
