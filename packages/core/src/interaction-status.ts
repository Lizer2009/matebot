/**
 * The one vocabulary for a card's lifecycle.
 *
 * Three lists disagreed before this module existed: the DB type in
 * `@matebot/db` had nine values, the block snapshot in `@matebot/contracts` had
 * six, and the read-side `SurfaceStatus` had three. A card could be `executing`
 * in one and `draft` in another, which is how a superseded card kept a live
 * Send button.
 *
 * This list is the DB truth. Everything else derives from it.
 */
export const INTERACTION_STATUSES = [
  "collecting",
  "ready_for_review",
  "awaiting_approval",
  "needs_connection",
  "unknown",
  "sent",
  "executed",
  "succeeded",
  "confirmed",
  "superseded",
  "expired",
  "failed",
  "cancelled",
] as const;

export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

/**
 * A card the user can still act on.
 *
 * These three, verbatim, are the `WHERE` clause of the partial unique index in
 * `20261126120000_interaction_card_key`. Changing this list without changing the
 * index silently removes the duplicate-card guarantee.
 */
export const OPEN_STATUSES = ["collecting", "ready_for_review", "awaiting_approval"] as const;

/**
 * Closed by a new user message. Identical to `OPEN_STATUSES` today, kept separate
 * because "can the user act" and "may a new message close it" are different
 * questions that happen to share an answer.
 */
export const AUTO_SETTLEABLE_STATUSES = OPEN_STATUSES;

/**
 * A card a new user message must **not** close.
 *
 * `needs_connection`: settling it breaks the reconnect resume (§5.5), whose only
 * fallback is re-asking the model for a card — possibly a different one.
 * `unknown`: the mail may already be out; settling it tells the user a lie.
 */
export const SETTLE_EXEMPT_STATUSES = ["needs_connection", "unknown"] as const;

/** A card `edit_interaction` may rewrite. */
export const EDITABLE_STATUSES = OPEN_STATUSES;

/** A card no transition leaves. */
export const TERMINAL_STATUSES = [
  "sent",
  "executed",
  "succeeded",
  "confirmed",
  "superseded",
  "expired",
  "failed",
  "cancelled",
] as const;

const OPEN_SET: ReadonlySet<string> = new Set(OPEN_STATUSES);
const AUTO_SETTLEABLE_SET: ReadonlySet<string> = new Set(AUTO_SETTLEABLE_STATUSES);
const EDITABLE_SET: ReadonlySet<string> = new Set(EDITABLE_STATUSES);
const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_STATUSES);

/** Whether the card still accepts the user's decision. */
export function isOpenStatus(status: string): boolean {
  return OPEN_SET.has(status);
}

/** Whether a new user message may close this card. */
export function isAutoSettleable(status: string): boolean {
  return AUTO_SETTLEABLE_SET.has(status);
}

/** Whether `edit_interaction` may rewrite this card. */
export function isEditableStatus(status: string): boolean {
  return EDITABLE_SET.has(status);
}

/** Whether this card has left the workflow for good. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_SET.has(status);
}
