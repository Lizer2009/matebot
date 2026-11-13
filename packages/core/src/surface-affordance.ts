/**
 * The one thing a card may still do.
 *
 * A card used to offer several buttons at once (`Connect` *and* `Send`, `Retry` *and*
 * `Check status`), and each host picked the set itself. Naming a single action is what stops
 * "the old card still had a working Send" from coming back: there is nothing to draw.
 */
export type SurfaceActionKind = "connect" | "submit" | "retry" | "check_status" | "none";

/**
 * Why a card is waiting. Closed set, stamped by the server, resolved to copy by key.
 *
 * `effect.amount` is reserved: no capability declares an amount threshold today, so it must not
 * be emitted until one does. Emitting a reason with no source is how a card starts explaining
 * itself wrongly.
 */
export const SURFACE_REASON_KEYS = [
  "rule.user",
  "rule.team",
  "setting.approval",
  "effect.irreversible",
] as const;

export type SurfaceReasonKey = (typeof SURFACE_REASON_KEYS)[number];

const REASONS: ReadonlySet<string> = new Set(SURFACE_REASON_KEYS);

export type SurfaceAffordance = {
  interactive: boolean;
  editable: boolean;
  action: SurfaceActionKind;
  terminal: boolean;
  reasonKey?: SurfaceReasonKey;
};

function fromStatus(status: string): SurfaceAffordance | undefined {
  switch (status) {
    case "collecting":
    case "ready_for_review":
    case "awaiting_approval":
      return { interactive: true, editable: true, action: "submit", terminal: false };
    case "needs_connection":
      return { interactive: true, editable: false, action: "connect", terminal: false };
    case "unknown":
      return { interactive: true, editable: false, action: "check_status", terminal: false };
    case "expired":
    case "failed":
      return { interactive: true, editable: false, action: "retry", terminal: true };
    case "superseded":
    case "cancelled":
    case "sent":
    case "executed":
    case "succeeded":
    case "confirmed":
      return { interactive: false, editable: false, action: "none", terminal: true };
    default:
      return undefined;
  }
}

/** What a block written before `status` existed can still say, from its lifecycle. */
function fromLifecycle(
  lifecycle: string | undefined,
  capability: string | undefined,
): SurfaceAffordance {
  if (capability === "not_connected" || capability === "requires_reauth") {
    return { interactive: true, editable: false, action: "connect", terminal: false };
  }
  switch (lifecycle) {
    case "succeeded":
      return { interactive: false, editable: false, action: "none", terminal: true };
    case "failed":
      return { interactive: true, editable: false, action: "retry", terminal: true };
    case "unknown":
      return { interactive: true, editable: false, action: "check_status", terminal: false };
    case "submitting":
    case "executing":
      return { interactive: false, editable: false, action: "none", terminal: false };
    case "draft":
      return { interactive: true, editable: true, action: "submit", terminal: false };
    default:
      // No status and no lifecycle: promise nothing rather than draw a control.
      return { interactive: false, editable: false, action: "none", terminal: false };
  }
}

/**
 * What this card may do, decided once for every host.
 *
 * A status wins over the lifecycle when present; a terminal affordance is never editable and
 * never `submit` — that pair is exactly the bug where a superseded draft kept a live Send.
 */
export function surfaceAffordanceFor(input: {
  status?: string;
  lifecycle?: string;
  capability?: string;
  reasonKey?: string;
}): SurfaceAffordance {
  const base =
    (input.status ? fromStatus(input.status) : undefined) ??
    fromLifecycle(input.lifecycle, input.capability);
  const safe = base.terminal ? { ...base, editable: false } : base;
  const reasonKey =
    input.reasonKey && REASONS.has(input.reasonKey)
      ? (input.reasonKey as SurfaceReasonKey)
      : undefined;
  return reasonKey ? { ...safe, reasonKey } : safe;
}

/** Whether the retry path may revive this status. Mirrors `reviveCard`'s whitelist. */
export function canRetryStatus(status: string): boolean {
  return status === "expired" || status === "failed";
}
