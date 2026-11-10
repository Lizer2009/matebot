import type { InteractionPlan } from "@matebot/contracts";
import {
  applyInteractionFieldChange,
  confirmInteractionDraftState,
  decideCancel,
  interactionSlotsFromPlan,
} from "@matebot/core";
import { describe, expect, it } from "vitest";

/**
 * The ordering rules around one draft, stated as cases.
 *
 * A card can be edited, confirmed and cancelled from two places at once — the person typing on
 * the card and the model calling `edit_interaction` — so what happens when they interleave is a
 * contract, not an implementation detail. Each case below is one of those interleavings written
 * the way it actually reaches the runtime.
 */

const PLAN: InteractionPlan = {
  intent: "email.compose",
  title: "冬天的问候",
  fields: [
    { name: "to", value: "a@example.test", required: true, status: "resolved" },
    { name: "subject", value: "旧主题", required: true, status: "resolved" },
    { name: "body", value: "正文", required: true, status: "resolved" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

function readyState(draftVersion = 3) {
  const slots = interactionSlotsFromPlan(PLAN);
  return {
    status: "ready_for_review" as const,
    draftVersion,
    confirmedVersion: null as number | null,
    plan: PLAN,
    slots,
  };
}

describe("a confirmation belongs to the version it was made against", () => {
  it("refuses the old confirmation after the subject is changed", () => {
    // The person confirms at version 3, then asks for a different subject. The edit becomes
    // version 4 and clears the confirmation, so version 3 no longer names anything.
    const state = readyState(3);
    const edited = applyInteractionFieldChange(state, {
      expectedDraftVersion: 3,
      name: "subject",
      value: "新主题",
      origin: "user",
    });
    if (!edited.ok) throw new Error(edited.message);

    expect(edited.draftVersion).toBe(4);
    expect(edited.confirmedVersion).toBeNull();
    // Confirming with the version the person saw before the edit must not stick.
    const stale = confirmInteractionDraftState(
      {
        status: edited.status,
        draftVersion: edited.draftVersion,
        confirmedVersion: edited.confirmedVersion,
        plan: edited.plan,
        slots: edited.slots,
      },
      3,
    );
    expect(stale).toMatchObject({ ok: false, error: "version_conflict" });
  });

  it("refuses a late model edit that quotes the version the person already moved past", () => {
    // The person typed on the card (version 4). The model's edit still names version 3, so it is
    // refused rather than writing over what they just entered.
    const state = {
      status: "ready_for_review" as const,
      draftVersion: 4,
      confirmedVersion: null as number | null,
      plan: PLAN,
      slots: interactionSlotsFromPlan(PLAN),
    };
    const late = applyInteractionFieldChange(state, {
      expectedDraftVersion: 3,
      name: "subject",
      value: "模型迟到的主题",
      origin: "model",
    });
    expect(late).toMatchObject({ ok: false, error: "version_conflict" });
  });

  it("refuses every confirmation once the draft is cancelled", () => {
    const cancelled = {
      ...readyState(3),
      status: "cancelled" as const,
    };
    const result = confirmInteractionDraftState(cancelled, 3);
    expect(result).toMatchObject({ ok: false, error: "terminal" });
  });

  it("does not let a cancelled draft accept edits either", () => {
    const cancelled = { ...readyState(3), status: "cancelled" as const };
    const edited = applyInteractionFieldChange(cancelled, {
      expectedDraftVersion: 3,
      name: "subject",
      value: "x",
      origin: "user",
    });
    expect(edited).toMatchObject({ ok: false, error: "terminal" });
  });
});

describe("an uncertain send is not retried by itself", () => {
  it("treats an unknown outcome as terminal for confirmation", () => {
    // A send whose outcome nobody knows must not be confirmed again; that would be a second
    // attempt at something that may already have happened.
    const state = { ...readyState(3), status: "unknown" as const };
    expect(confirmInteractionDraftState(state, 3)).toMatchObject({ ok: false, error: "terminal" });
  });

  it("refuses to cancel an uncertain send by calling it cancelled", () => {
    // The outcome is unknown, so cancelling would hide a possible effect. The draft stays as it
    // is and the reason says so; it is not silently dropped and not reported as cancelled.
    const decision = decideCancel({ status: "unknown", runtimeCanAbort: true });
    expect(decision).toMatchObject({ ok: false, error: "in_flight" });
  });

  it("will not confirm a draft that already succeeded", () => {
    const state = { ...readyState(3), status: "succeeded" as const };
    expect(confirmInteractionDraftState(state, 3)).toMatchObject({ ok: false, error: "terminal" });
  });
});

describe("an incomplete draft cannot be confirmed at any version", () => {
  it("refuses a draft whose body is empty even at the current version", () => {
    const slots = interactionSlotsFromPlan(PLAN);
    delete slots.body;
    const state = {
      status: "collecting" as const,
      draftVersion: 3,
      confirmedVersion: null as number | null,
      plan: PLAN,
      slots,
    };
    expect(confirmInteractionDraftState(state, 3)).toMatchObject({ ok: false, error: "not_ready" });
  });
});

describe("the person's own text survives a later model edit", () => {
  it("records the author on the field it wrote", () => {
    const state = readyState(1);
    const mine = applyInteractionFieldChange(state, {
      expectedDraftVersion: 1,
      name: "subject",
      value: "我写的主题",
      origin: "user",
    });
    if (!mine.ok) throw new Error(mine.message);
    const field = mine.plan.fields.find((entry) => entry.name === "subject");
    expect(field?.value).toBe("我写的主题");
    // The stamp is what a later model edit consults before overwriting.
    expect(field?.source).toBe("user");
  });

  it("stamps a model edit as the model's, so it is not mistaken for the person's", () => {
    const state = readyState(1);
    const theirs = applyInteractionFieldChange(state, {
      expectedDraftVersion: 1,
      name: "subject",
      value: "模型的主题",
      origin: "model",
    });
    if (!theirs.ok) throw new Error(theirs.message);
    expect(theirs.plan.fields.find((entry) => entry.name === "subject")?.source).toBe("model");
  });
});

describe("the same draft is the default target", () => {
  it("increments the version in place instead of creating another draft", () => {
    const state = readyState(5);
    const edited = applyInteractionFieldChange(state, {
      expectedDraftVersion: 5,
      name: "body",
      value: "新的正文",
      origin: "user",
    });
    if (!edited.ok) throw new Error(edited.message);
    // One plan, one title: nothing here creates a second card.
    expect(edited.draftVersion).toBe(6);
    expect(edited.plan.fields.filter((field) => field.name === "body")).toHaveLength(1);
    expect(edited.slots.body).toBe("新的正文");
  });
});
