import { describe, expect, it } from "vitest";
import type { OpenSurface } from "./surface-target.js";
import { resolveSurfaceTarget } from "./surface-target.js";

/**
 * A chat can hold several live cards. "把它改一下" must not pick one by
 * position or recency — the spec requires clarification when the referent is
 * genuinely ambiguous. This is the guard against editing the wrong card.
 */

function surface(overrides: Partial<OpenSurface>): OpenSurface {
  return {
    taskId: "task-1",
    surfaceId: "surf-1",
    intent: "email.compose",
    label: "Email to a@example.com",
    status: "draft",
    ...overrides,
  };
}

describe("resolveSurfaceTarget", () => {
  it("targets the only open surface without asking", () => {
    expect(resolveSurfaceTarget({ surfaces: [surface({})], reference: undefined })).toEqual({
      kind: "target",
      taskId: "task-1",
    });
  });

  it("targets an explicitly named surface even when several are open", () => {
    const result = resolveSurfaceTarget({
      surfaces: [
        surface({ taskId: "task-1", surfaceId: "surf-1" }),
        surface({ taskId: "task-2", surfaceId: "surf-2", label: "Email to b@example.com" }),
      ],
      reference: { taskId: "task-2" },
    });
    expect(result).toEqual({ kind: "target", taskId: "task-2" });
  });

  it("asks which card when a pronoun could mean either", () => {
    const result = resolveSurfaceTarget({
      surfaces: [
        surface({ taskId: "task-1", surfaceId: "surf-1" }),
        surface({ taskId: "task-2", surfaceId: "surf-2", label: "Email to b@example.com" }),
      ],
      reference: { pronoun: true },
    });
    expect(result).toMatchObject({ kind: "clarify" });
    if (result.kind !== "clarify") return;
    // The user needs the candidates to choose between, not a guess.
    expect(result.candidates.map((candidate) => candidate.taskId)).toEqual(["task-1", "task-2"]);
  });

  it("asks when no card is open", () => {
    expect(resolveSurfaceTarget({ surfaces: [], reference: undefined })).toEqual({
      kind: "none",
    });
  });

  it("ignores cards that already executed, since they are immutable", () => {
    const result = resolveSurfaceTarget({
      surfaces: [
        surface({ taskId: "task-1", status: "executed" }),
        surface({ taskId: "task-2", surfaceId: "surf-2" }),
      ],
      reference: { pronoun: true },
    });
    expect(result).toEqual({ kind: "target", taskId: "task-2" });
  });

  it("refuses a name that matches no open card", () => {
    expect(
      resolveSurfaceTarget({
        surfaces: [surface({})],
        reference: { taskId: "task-missing" },
      }),
    ).toEqual({ kind: "not_found" });
  });

  // Two cards for the same mailbox are still two tasks: do not merge them.
  it("treats same-intent cards as distinct tasks", () => {
    const result = resolveSurfaceTarget({
      surfaces: [
        surface({ taskId: "task-1", label: "Email to a@example.com" }),
        surface({ taskId: "task-2", surfaceId: "surf-2", label: "Email to a@example.com" }),
      ],
      reference: { pronoun: true },
    });
    expect(result.kind).toBe("clarify");
  });
});
