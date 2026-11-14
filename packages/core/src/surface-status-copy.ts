import type { SurfaceReasonKey } from "./surface-affordance.js";

/**
 * The keys a card's copy can come from.
 *
 * Keys, not sentences: the server does not know the reader's locale, and returning English prose
 * would make the status line the one untranslated thing on screen. Each host resolves these
 * through its own function, typed `Record<SurfaceCopyKey, string>`, so a new key fails to compile
 * until every host has a line for it — that is how AC-14 is enforced instead of scanned for.
 */
export const SURFACE_COPY_KEYS = [
  "status.draft",
  "status.replaced",
  "status.expired",
  "status.failed",
  "status.cancelled",
  "status.unknown",
  "status.succeeded",
  "reason.rule_user",
  "reason.rule_team",
  "reason.setting_approval",
  "reason.effect_irreversible",
  "action.retry",
  "action.check_status",
  "hint.stale",
] as const;

export type SurfaceCopyKey = (typeof SURFACE_COPY_KEYS)[number];

export function surfaceStatusCopy(input: { status: string }): {
  titleKey: SurfaceCopyKey;
  actionKey?: SurfaceCopyKey;
} {
  switch (input.status) {
    case "superseded":
      return { titleKey: "status.replaced" };
    case "expired":
      return { titleKey: "status.expired", actionKey: "action.retry" };
    case "failed":
      return { titleKey: "status.failed", actionKey: "action.retry" };
    case "cancelled":
      return { titleKey: "status.cancelled" };
    case "unknown":
      return { titleKey: "status.unknown", actionKey: "action.check_status" };
    case "sent":
    case "executed":
    case "succeeded":
    case "confirmed":
      return { titleKey: "status.succeeded" };
    default:
      return { titleKey: "status.draft" };
  }
}

const REASON_COPY: Record<SurfaceReasonKey, SurfaceCopyKey> = {
  "rule.user": "reason.rule_user",
  "rule.team": "reason.rule_team",
  "setting.approval": "reason.setting_approval",
  "effect.irreversible": "reason.effect_irreversible",
};

export function surfaceReasonCopy(reason: SurfaceReasonKey): SurfaceCopyKey {
  return REASON_COPY[reason];
}

/** The staleness hint. Not a status: a card can be current and marked at once (§4.3). */
export function surfaceStaleHint(): SurfaceCopyKey {
  return "hint.stale";
}
