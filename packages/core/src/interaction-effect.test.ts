import { describe, expect, it } from "vitest";
import {
  confirmedEffectMatchesDraft,
  interactionConfirmEffectRequest,
  interactionConfirmIdempotencyKey,
  interactionEffectKind,
} from "./interaction-effect.js";

describe("interaction effect binding", () => {
  it("builds a stable idempotency key and request for the confirmed draft", () => {
    expect(interactionConfirmIdempotencyKey("ix-1", 4)).toBe("a2ui:interaction:ix-1:confirm:4");
    expect(
      interactionConfirmEffectRequest({
        interactionId: "ix-1",
        intent: "email.compose",
        draftVersion: 4,
        confirmedVersion: 4,
        slots: { to: "a@example.com", subject: "Hi" },
      }),
    ).toEqual({
      interactionId: "ix-1",
      intent: "email.compose",
      draftVersion: 4,
      confirmedVersion: 4,
      slots: { to: "a@example.com", subject: "Hi" },
    });
  });

  it("uses email.send for compose and a neutral kind otherwise", () => {
    expect(interactionEffectKind("email.compose")).toBe("email.send");
    expect(interactionEffectKind("email.send")).toBe("email.send");
    expect(interactionEffectKind("calendar.create")).toBe("interaction.confirm");
  });

  it("matches an effect only when both versions agree", () => {
    const request = { draftVersion: 3, confirmedVersion: 3 };
    expect(confirmedEffectMatchesDraft(request, { draftVersion: 3, confirmedVersion: 3 })).toBe(
      true,
    );
    expect(confirmedEffectMatchesDraft(request, { draftVersion: 4, confirmedVersion: 3 })).toBe(
      false,
    );
    expect(confirmedEffectMatchesDraft(request, { draftVersion: 3, confirmedVersion: null })).toBe(
      false,
    );
  });
});
