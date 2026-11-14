import type { InteractionStatus } from "./interaction-status.js";
import {
  INTERACTION_STATUSES,
  isTerminalStatus,
  SETTLE_EXEMPT_STATUSES,
} from "./interaction-status.js";

/**
 * Why a settle was refused. Every caller reports the reason rather than
 * silently doing nothing: a sweep that skipped a card and said nothing is how
 * an in-doubt email would look "expired" to the user.
 */
export type SettleRefusal =
  | "already_terminal"
  | "exempt_from_settlement"
  | "unknown_status"
  | "same_status"
  | "not_terminal_target";

export type SettleDecision =
  | { ok: true; status: InteractionStatus }
  | { ok: false; reason: SettleRefusal };

const KNOWN: ReadonlySet<string> = new Set(INTERACTION_STATUSES);
const EXEMPT: ReadonlySet<string> = new Set(SETTLE_EXEMPT_STATUSES);

/**
 * The single rule for whether a card may move from `current` to `next`.
 *
 * Pure on purpose: the storage layer owns the write, this owns the decision, so
 * the rules can be tested exhaustively without a database.
 */
export function decideSettle(input: { current: string; next: InteractionStatus }): SettleDecision {
  const { current, next } = input;
  if (!KNOWN.has(current)) return { ok: false, reason: "unknown_status" };
  if (current === next) return { ok: false, reason: "same_status" };
  if (EXEMPT.has(current)) {
    // Sweeps must not close a reconnect or an in-doubt send (D1/D2). Completing
    // an L0-A connection card is a user action, not a sweep: succeeded/cancelled
    // are allowed from `needs_connection`. `unknown` stays fully exempt.
    if (
      current === "needs_connection" &&
      isTerminalStatus(next) &&
      next !== "superseded" &&
      next !== "expired"
    ) {
      return { ok: true, status: next };
    }
    return { ok: false, reason: "exempt_from_settlement" };
  }
  if (isTerminalStatus(current)) return { ok: false, reason: "already_terminal" };
  if (!isTerminalStatus(next)) return { ok: false, reason: "not_terminal_target" };
  return { ok: true, status: next };
}

/** How long an approval card stays actionable: the design's thirty-minute approval TTL. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * The expiry to stamp when publishing in `status`.
 *
 * Only approvals expire. A draft the user is still editing must not be taken
 * away, a sign-in takes as long as it takes, and an in-doubt email may already
 * be sent — a timer on any of those would either interrupt the user or lie.
 */
export function expiresAtFor(status: InteractionStatus, now: Date = new Date()): Date | null {
  if (status !== "awaiting_approval") return null;
  return new Date(now.getTime() + APPROVAL_TTL_MS);
}
