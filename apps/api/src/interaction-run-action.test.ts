import { describe, expect, it, vi } from "vitest";
import type { ConfirmThenExecuteDeps } from "./interaction-run-action.js";
import { confirmThenExecute } from "./interaction-run-action.js";

/**
 * The action a compiled button runs must be the *existing* confirm-then-execute
 * path, not a parallel one. These tests pin that: the bridge refuses to claim
 * success unless the real service actually ran, and a confirm refusal must not
 * be reported as executed.
 */

const baseInput = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  interactionId: "ix-1",
  revision: 3,
  userId: "user-1",
};

function deps(overrides: Partial<ConfirmThenExecuteDeps> = {}): ConfirmThenExecuteDeps {
  return {
    confirm: vi.fn(async () => ({ confirmedVersion: 3, effectId: "e-1", idempotencyKey: "k" })),
    execute: vi.fn(async () => ({
      effectId: "e-1",
      idempotencyKey: "k",
      duplicate: false,
      executed: true,
    })),
    ...overrides,
  };
}

describe("confirmThenExecute", () => {
  it("confirms the exact revision then executes, and reports executed", async () => {
    const d = deps();
    const result = await confirmThenExecute(d, { ...baseInput, kind: "email.send" });
    expect(result).toEqual({ ok: true });
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ draftVersion: 3 }));
    expect(d.execute).toHaveBeenCalledTimes(1);
  });

  it("does not execute when confirming is refused", async () => {
    const d = deps({
      confirm: vi.fn(async () => {
        const error = new Error("Reconnect the mailbox before sending");
        error.name = "InteractionSendRejectedError";
        Object.assign(error, { code: "needs_connection" });
        throw error;
      }),
    });
    const result = await confirmThenExecute(d, { ...baseInput, kind: "email.send" });
    expect(result).toEqual({ ok: false, error: "needs_connection" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("reports a refused execute rather than claiming success", async () => {
    const d = deps({
      execute: vi.fn(async () => {
        const error = new Error("Send result is unknown; do not send again");
        error.name = "InteractionSendRejectedError";
        Object.assign(error, { code: "unknown" });
        throw error;
      }),
    });
    expect(await confirmThenExecute(d, { ...baseInput, kind: "email.send" })).toEqual({
      ok: false,
      error: "unknown",
    });
  });

  // A capability whose action has no effect yet must say so, not report success.
  it("refuses an effect kind with no sender", async () => {
    const d = deps();
    expect(await confirmThenExecute(d, { ...baseInput, kind: null })).toEqual({
      ok: false,
      error: "unknown_action",
    });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.execute).not.toHaveBeenCalled();
  });
});
