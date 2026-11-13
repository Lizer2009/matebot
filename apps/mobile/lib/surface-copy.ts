import type { SurfaceCopyKey } from "@matebot/core";

/**
 * The mobile words for a card's status.
 *
 * Keys are the English source sentences the locale catalogs index by. `t` is the host's
 * translator so a language switch follows the rest of the app. A `switch` keeps every
 * sentence a scanned string literal.
 */
export function surfaceCopy(t: (message: string) => string, key: SurfaceCopyKey): string {
  switch (key) {
    case "status.draft":
      return t("Draft");
    case "status.replaced":
      return t("Replaced by a newer draft");
    case "status.expired":
      return t("Expired, nothing was sent");
    case "status.failed":
      return t("Failed");
    case "status.cancelled":
      return t("Discarded");
    case "status.unknown":
      return t("Checking whether this was sent");
    case "status.succeeded":
      return t("Done");
    case "reason.rule_user":
      return t("Your rule asks first");
    case "reason.rule_team":
      return t("This space's rules ask first");
    case "reason.setting_approval":
      return t("Your settings ask first");
    case "reason.effect_irreversible":
      return t("This step cannot be undone");
    case "action.retry":
      return t("Retry");
    case "action.check_status":
      return t("Check status");
    case "hint.stale":
      return t("There may be a newer version");
  }
}
