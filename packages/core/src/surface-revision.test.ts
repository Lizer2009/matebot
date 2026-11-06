import { describe, expect, it } from "vitest";
import type { SurfaceRevisionState } from "./surface-revision.js";
import { acceptSurfaceEvent, applySurfaceEdit, canSubmitSurface } from "./surface-revision.js";

/**
 * Multi-turn contract: one task keeps one surface, edits bump a revision, a
 * late or replayed event must not roll the user's typing backwards, and a
 * change to an approved payload invalidates that approval.
 */

function state(overrides: Partial<SurfaceRevisionState> = {}): SurfaceRevisionState {
  return {
    taskId: "task-1",
    surfaceId: "surf-1",
    revision: 3,
    status: "draft",
    values: { to: "a@example.com", subject: "Hi" },
    editedFields: [],
    ...overrides,
  };
}

describe("acceptSurfaceEvent", () => {
  it("accepts an event newer than the surface", () => {
    const result = acceptSurfaceEvent(state(), { revision: 4 });
    expect(result).toMatchObject({ accept: true });
  });

  it("drops a replayed or out-of-order event instead of rewinding", () => {
    expect(acceptSurfaceEvent(state(), { revision: 3 })).toMatchObject({ accept: false });
    expect(acceptSurfaceEvent(state(), { revision: 2 })).toMatchObject({ accept: false });
  });

  it("says why it dropped, so a host can log without guessing", () => {
    expect(acceptSurfaceEvent(state(), { revision: 2 })).toMatchObject({
      accept: false,
      reason: "stale",
    });
  });

  it("drops an event for a different surface", () => {
    expect(acceptSurfaceEvent(state(), { revision: 9, surfaceId: "other" })).toMatchObject({
      accept: false,
      reason: "different_surface",
    });
  });
});

describe("applySurfaceEdit", () => {
  it("bumps the revision and records the field the user changed", () => {
    const next = applySurfaceEdit(state(), { name: "subject", value: "Hello" });
    expect(next).toMatchObject({
      revision: 4,
      values: { to: "a@example.com", subject: "Hello" },
      editedFields: ["subject"],
    });
  });

  // A late model update must not overwrite what the user typed.
  it("keeps a user-edited field when a model update arrives for it", () => {
    const edited = applySurfaceEdit(state(), { name: "subject", value: "Mine" });
    const merged = applySurfaceEdit(edited, {
      name: "subject",
      value: "Model says otherwise",
      origin: "model",
    });
    expect(merged.values.subject).toBe("Mine");
  });

  it("lets the model fill a field the user has not touched", () => {
    const merged = applySurfaceEdit(state(), {
      name: "body",
      value: "Draft body",
      origin: "model",
    });
    expect(merged.values.body).toBe("Draft body");
  });

  it("invalidates a confirmation when the approved payload changes", () => {
    const approved = state({ status: "approved" });
    const edited = applySurfaceEdit(approved, { name: "subject", value: "Changed" });
    expect(edited.status).toBe("draft");
  });

  it("refuses to edit a surface that already executed", () => {
    expect(() =>
      applySurfaceEdit(state({ status: "executed" }), { name: "subject", value: "x" }),
    ).toThrow(/immutable/i);
  });

  it("keeps an executed record immutable and expects a linked new draft instead", () => {
    const executed = state({ status: "executed" });
    const amendment = applySurfaceEdit(executed, {
      name: "subject",
      value: "Corrected",
      origin: "amendment",
      newTaskId: "task-2",
    });
    expect(amendment).toMatchObject({
      taskId: "task-2",
      status: "draft",
      revision: 1,
      amendsTaskId: "task-1",
    });
    // The original row is untouched.
    expect(executed.values.subject).toBe("Hi");
    expect(executed.status).toBe("executed");
  });

  it("does not bump the revision when the value is unchanged", () => {
    const next = applySurfaceEdit(state(), { name: "subject", value: "Hi" });
    expect(next.revision).toBe(3);
    expect(next.editedFields).toEqual([]);
  });
});

describe("canSubmitSurface", () => {
  it("accepts the exact approved revision", () => {
    expect(
      canSubmitSurface({ state: state({ status: "approved" }), submittedRevision: 3 }),
    ).toEqual({ ok: true });
  });

  it("refuses a click from an older revision", () => {
    expect(
      canSubmitSurface({ state: state({ status: "approved" }), submittedRevision: 2 }),
    ).toEqual({ ok: false, error: "stale_revision" });
  });

  it("refuses a draft that was never approved, so prose cannot silently send", () => {
    expect(canSubmitSurface({ state: state(), submittedRevision: 3 })).toEqual({
      ok: false,
      error: "not_approved",
    });
  });

  it("refuses a second submit after the task executed", () => {
    expect(
      canSubmitSurface({ state: state({ status: "executed" }), submittedRevision: 3 }),
    ).toEqual({ ok: false, error: "already_executed" });
  });
});
