import { i18n } from "@lingui/core";
import type { SurfaceCopyKey } from "@matebot/core";

/**
 * The web words for a card's status.
 *
 * Resolved at call time, not at import: Lingui's `t` macro evaluates where it appears, so a
 * module-level table would freeze whatever locale was active during the first import and never
 * follow a language switch. The `switch` also keeps every string statically extractable.
 */
export function surfaceCopy(key: SurfaceCopyKey): string {
  switch (key) {
    case "status.draft":
      return i18n._({ id: "Draft", message: "Draft" });
    case "status.replaced":
      return i18n._({ id: "Replaced by a newer draft", message: "Replaced by a newer draft" });
    case "status.expired":
      return i18n._({ id: "Expired, nothing was sent", message: "Expired, nothing was sent" });
    case "status.failed":
      return i18n._({ id: "Failed", message: "Failed" });
    case "status.cancelled":
      return i18n._({ id: "Discarded", message: "Discarded" });
    case "status.unknown":
      return i18n._({
        id: "Checking whether this was sent",
        message: "Checking whether this was sent",
      });
    case "status.succeeded":
      return i18n._({ id: "Done", message: "Done" });
    case "reason.rule_user":
      return i18n._({ id: "Your rule asks first", message: "Your rule asks first" });
    case "reason.rule_team":
      return i18n._({
        id: "This space's rules ask first",
        message: "This space's rules ask first",
      });
    case "reason.setting_approval":
      return i18n._({ id: "Your settings ask first", message: "Your settings ask first" });
    case "reason.effect_irreversible":
      return i18n._({ id: "This step cannot be undone", message: "This step cannot be undone" });
    case "action.retry":
      return i18n._({ id: "Retry", message: "Retry" });
    case "action.check_status":
      return i18n._({ id: "Check status", message: "Check status" });
    case "hint.stale":
      return i18n._({
        id: "There may be a newer version",
        message: "There may be a newer version",
      });
  }
}
