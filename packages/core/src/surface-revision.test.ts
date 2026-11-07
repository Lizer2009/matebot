import { describe, expect, it } from "vitest";
import type { SurfaceRevisionState } from "./surface-revision.js";
import { canSubmitSurface } from "./surface-revision.js";

/**
 * Submitting a surface: the primary click must carry the exact revision on
 * screen, and a task that already executed cannot be submitted again.
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
