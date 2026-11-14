import { describe, expect, it } from "vitest";
import { shouldSkipDraftCard } from "./interaction-draft-policy.js";

describe("shouldSkipDraftCard", () => {
  it("skips an action draft when drafts are disabled and approval allows", () => {
    expect(
      shouldSkipDraftCard({
        draftsDisabled: true,
        intent: "email.compose",
        approval: "allow",
        status: "collecting",
      }),
    ).toBe(true);
    expect(
      shouldSkipDraftCard({
        draftsDisabled: true,
        intent: "email.send",
        approval: "allow",
      }),
    ).toBe(true);
  });

  it("does not skip when approval is required or denied", () => {
    expect(
      shouldSkipDraftCard({
        draftsDisabled: true,
        intent: "email.compose",
        approval: "ask",
      }),
    ).toBe(false);
    expect(
      shouldSkipDraftCard({
        draftsDisabled: true,
        intent: "email.compose",
        approval: "deny",
      }),
    ).toBe(false);
  });

  it("does not skip result cards or connection cards", () => {
    expect(
      shouldSkipDraftCard({
        draftsDisabled: true,
        intent: "interaction.result",
        approval: "allow",
      }),
    ).toBe(false);
    expect(
      shouldSkipDraftCard({
        draftsDisabled: true,
        intent: "email.compose",
        approval: "allow",
        status: "needs_connection",
      }),
    ).toBe(false);
  });

  it("does not skip when drafts are still on", () => {
    expect(
      shouldSkipDraftCard({
        draftsDisabled: false,
        intent: "email.compose",
        approval: "allow",
      }),
    ).toBe(false);
  });
});
