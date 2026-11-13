import { describe, expect, it } from "vitest";
import { interactionCapabilityForIntent } from "./interaction-capability.js";
import { surfaceCardTitle } from "./surface-card-title.js";

describe("surfaceCardTitle", () => {
  it("uses a category plus the card's content for a review card", () => {
    expect(
      surfaceCardTitle({
        capability: interactionCapabilityForIntent("email.compose")!,
        title: "产品发布",
      }),
    ).toEqual({ category: "Email", title: "产品发布", shape: "review" });
  });

  it("asks a question for a decision card", () => {
    const email = interactionCapabilityForIntent("email.compose")!;
    const decision = { ...email, cardShape: "decision" as const };
    expect(surfaceCardTitle({ capability: decision, title: "添加 Firecrawl" }).title).toBe(
      "Add Firecrawl?",
    );
  });

  it("falls back to the capability label when no title was given", () => {
    expect(
      surfaceCardTitle({ capability: interactionCapabilityForIntent("calendar.create")! }).title,
    ).toBe("Calendar");
  });
});
