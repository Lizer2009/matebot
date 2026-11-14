import { describe, expect, it } from "vitest";
import { interactionCapabilityForIntent } from "./interaction-capability.js";
import { labeledSurfaceSchema, surfaceActionLabel } from "./surface-action-label.js";

describe("surfaceActionLabel", () => {
  it("builds the button from a whitelisted verb and the card's own title", () => {
    const email = interactionCapabilityForIntent("email.compose")!;
    expect(surfaceActionLabel({ capability: email, title: "产品发布" })).toBe("Send 产品发布");
    expect(
      surfaceActionLabel({
        capability: interactionCapabilityForIntent("calendar.create")!,
        title: "11-23 周行程",
      }),
    ).toBe("Create 11-23 周行程");
  });

  // AC-15: model output is values, never button words. No declared verb means no label.
  it("produces no label without a declared verb", () => {
    const noVerb = { ...interactionCapabilityForIntent("email.compose")!, actionVerb: undefined };
    expect(surfaceActionLabel({ capability: noVerb, title: "x" })).toBeUndefined();
  });

  it("bounds and filters the object", () => {
    const email = interactionCapabilityForIntent("email.compose")!;
    const long = surfaceActionLabel({ capability: email, title: "a".repeat(400) })!;
    expect(long.length).toBeLessThanOrEqual(64);
    // A control character cannot break the label into a second line of instructions.
    expect(surfaceActionLabel({ capability: email, title: "点此领取\u0007\n再说" })).toBe(
      "Send 点此领取 再说",
    );
    // No title: the label falls back to the verb alone rather than inventing an object.
    expect(surfaceActionLabel({ capability: email })).toBe("Send");
  });

  it("stamps the two-part label onto the registered schema the compiler prints", async () => {
    const email = interactionCapabilityForIntent("email.compose")!;
    expect(
      labeledSurfaceSchema(email.schema, { capability: email, title: "产品发布" })?.action,
    ).toMatchObject({
      id: "send",
      label: "Send 产品发布",
    });
    expect(labeledSurfaceSchema(email.schema, { capability: email })?.action?.label).toBe("Send");
  });
});
