import { describe, expect, it } from "vitest";
import {
  applyInteractionFieldChange,
  canExecuteConfirmedInteraction,
  confirmInteractionDraftState,
  deriveCollectingStatus,
  interactionSlotsFromPlan,
  requiredFieldsSatisfied,
} from "./interaction-runtime.js";

const plan = {
  intent: "email.compose",
  title: "Send email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved" as const },
    { name: "subject", required: true, status: "missing" as const },
    { name: "body", value: "", required: true, status: "missing" as const },
  ],
  nextStep: "ask" as const,
  riskLevel: "medium" as const,
};

describe("interaction-runtime", () => {
  it("derives slots and readiness from the plan", () => {
    const slots = interactionSlotsFromPlan(plan);
    expect(slots).toEqual({ to: "a@example.com", body: "" });
    expect(requiredFieldsSatisfied(plan, slots)).toBe(false);
    expect(
      requiredFieldsSatisfied(plan, { to: "a@example.com", subject: "Hi", body: "Hello" }),
    ).toBe(true);
    expect(deriveCollectingStatus(plan, slots, "collecting")).toBe("collecting");
  });

  it("increments draftVersion and clears confirmation on field edit", () => {
    const result = applyInteractionFieldChange(
      {
        status: "awaiting_approval",
        draftVersion: 2,
        confirmedVersion: 2,
        plan,
        slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
      },
      { expectedDraftVersion: 2, name: "subject", value: "Hello again" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draftVersion).toBe(3);
    expect(result.confirmedVersion).toBeNull();
    expect(result.status).toBe("ready_for_review");
    expect(result.slots.subject).toBe("Hello again");
  });

  it("rejects stale expectedDraftVersion and unknown fields", () => {
    const state = {
      status: "collecting" as const,
      draftVersion: 1,
      confirmedVersion: null,
      plan,
      slots: interactionSlotsFromPlan(plan),
    };
    expect(
      applyInteractionFieldChange(state, {
        expectedDraftVersion: 9,
        name: "subject",
        value: "x",
      }).ok,
    ).toBe(false);
    expect(
      applyInteractionFieldChange(state, {
        expectedDraftVersion: 1,
        name: "cc",
        value: "x",
      }),
    ).toMatchObject({ error: "unknown_field" });
  });

  it("confirms only a ready matching draft", () => {
    const ready = {
      status: "ready_for_review" as const,
      draftVersion: 4,
      confirmedVersion: null,
      plan,
      slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    };
    expect(confirmInteractionDraftState(ready, 4)).toEqual({
      ok: true,
      confirmedVersion: 4,
      status: "awaiting_approval",
    });
    expect(confirmInteractionDraftState(ready, 3).ok).toBe(false);
    expect(
      canExecuteConfirmedInteraction({
        draftVersion: 4,
        confirmedVersion: 4,
        status: "awaiting_approval",
      }),
    ).toEqual({ ok: true });
    expect(
      canExecuteConfirmedInteraction({
        draftVersion: 5,
        confirmedVersion: 4,
        status: "awaiting_approval",
      }).ok,
    ).toBe(false);
    expect(
      canExecuteConfirmedInteraction({
        draftVersion: 4,
        confirmedVersion: 4,
        status: "unknown",
      }),
    ).toMatchObject({ error: "unknown" });
    expect(
      canExecuteConfirmedInteraction({
        draftVersion: 4,
        confirmedVersion: 4,
        status: "failed",
      }),
    ).toEqual({ ok: true });
    expect(
      canExecuteConfirmedInteraction({
        draftVersion: 4,
        confirmedVersion: 4,
        status: "executing",
      }),
    ).toMatchObject({ error: "unconfirmed" });
  });

  it("rejects field edits after send starts, fails, or goes unknown", () => {
    const ready = {
      draftVersion: 4,
      confirmedVersion: 4,
      plan,
      slots: { to: "a@example.com", subject: "Hi", body: "Hello" },
    };
    for (const status of ["executing", "failed", "unknown", "succeeded"] as const) {
      expect(
        applyInteractionFieldChange(
          { ...ready, status },
          { expectedDraftVersion: 4, name: "subject", value: "Nope" },
        ),
      ).toMatchObject({ error: "terminal" });
    }
  });
});
