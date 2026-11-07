import { describe, expect, it } from "vitest";
import { promptStatesPeriod, windowDecision } from "./query-window.js";

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

  /**
   * The detector is a floor, so it must not claim a period where there is none.
   * "May" is a month name and also an ordinary word, and a prompt with no period at
   * all was once read as stating one — which publishes an invented window as the
   * person's own.
   */
  it.each([
    "May I see the draft",
    "can you show me the numbers",
    "how did we do",
    "what does the pipeline look like",
    "show me the sales",
  ])("does not read a period out of %j", (prompt) => {
    expect(promptStatesPeriod(prompt)).toBe(false);
  });

  it.each([
    ["a quarter label", "show Q2 revenue"],
    ["a quarter and year", "Q2 2026 revenue"],
    ["a count of days", "the last 7 days"],
    ["a count of weeks in the past", "sales for the past 2 weeks"],
    ["a Chinese month", "12月的销售"],
    ["a Chinese recent window", "过去7天的数据"],
    ["a Chinese quarter", "第2季度的收入"],
    ["a fiscal year", "FY2026 totals"],
    ["a month with a day", "November 9 flights"],
    ["a day with a month", "flights on 9 Nov"],
    ["in a month", "revenue in November"],
  ])("reads %s as a stated period", (_label, prompt) => {
    expect(promptStatesPeriod(prompt)).toBe(true);
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

  it("is unstated when nobody said, which is published only after asking", () => {
    expect(windowDecision({ claimedByModel: false, userPrompt: "show me sales" })).toBe("unstated");
  });
});
