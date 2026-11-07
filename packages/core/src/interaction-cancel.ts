import type { InteractionLifecycleStatus } from "./interaction-runtime.js";

/**
 * Cancelling a draft, and what cancelling may never claim.
 *
 * Spec §6.5.2: a cancel may ask the runtime to abort only while the action has
 * not started, and once an effect has completed there is nothing to undo. So the
 * decision is made from the recorded state, not from what the user asks for: a
 * draft that never ran can be cancelled; one whose action is in flight is refused
 * with "already running"; one that executed is refused because the event exists
 * and cancelling the card would not unsend it.
 */

export type CancelDecision =
  | { ok: true; status: "cancelled" }
  | {
      /**
       * The action is still running and this runtime can abort it. The caller
       * requests the abort; the effect settles as failed or unknown afterwards,
       * never as "cancelled and nothing happened".
       */
      ok: true;
      status: "abort_requested";
    }
  | {
      ok: false;
      error: "already_executed" | "in_flight" | "terminal";
      /**
       * What the user must be told. A cancel that cannot happen says why, and
       * a record that already executed says plainly that it cannot be undone.
       */
      message: string;
    };

/**
 * Decide what a cancel may do.
 *
 * `runtimeCanAbort` reflects whether this deployment can actually stop an
 * in-flight provider request. The spec makes the abort conditional on exactly
 * that (§6.5.2: "request an abort only when the runtime supports it"), so it is a
 * parameter rather than an assumption: a runtime that cannot abort must refuse
 * and say so, not silently do nothing and report success.
 */
export function decideCancel(input: {
  status: InteractionLifecycleStatus;
  runtimeCanAbort?: boolean;
}): CancelDecision {
  switch (input.status) {
    case "succeeded":
      return {
        ok: false,
        error: "already_executed",
        message: "这个操作已经完成，无法撤销。如需更正，我会新建一张关联草稿。",
      };
    case "unknown":
      // The outcome is not known yet; cancelling would hide a possible effect.
      return {
        ok: false,
        error: "in_flight",
        message: "这次操作的结果还不确定，我会先核对，而不是当作已取消。",
      };
    case "executing":
      if (input.runtimeCanAbort) return { ok: true, status: "abort_requested" };
      return {
        ok: false,
        error: "in_flight",
        message: "这次操作已经在进行中，不能再取消。",
      };
    case "cancelled":
      return { ok: false, error: "terminal", message: "这张草稿已经取消过了。" };
    case "failed":
      return { ok: false, error: "terminal", message: "这次操作已经结束（失败），无需取消。" };
    default:
      return { ok: true, status: "cancelled" };
  }
}

/**
 * Whether an executed record can be corrected. A correction is always a new
 * linked draft: the executed row is a record of what happened and never changes,
 * and running the correction needs its own permission like any other effect.
 */
export function describeAmendment(input: { status: InteractionLifecycleStatus }): {
  allowed: boolean;
  requiresNewDraft: boolean;
} {
  return {
    allowed: true,
    requiresNewDraft: input.status === "succeeded" || input.status === "executing",
  };
}
