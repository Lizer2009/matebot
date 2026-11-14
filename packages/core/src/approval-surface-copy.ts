import type { MessageBlock } from "@matebot/contracts";

/**
 * Slack's deny button says Skip; the thread still says Deny.
 *
 * Same action id (`deny`), so settlement does not fork. Spec §14 #11.
 */
export function approvalDenyLabel(surface: "thread" | "slack"): "Deny" | "Skip" {
  return surface === "slack" ? "Skip" : "Deny";
}

export function relabelApprovalActionsForSlack<T extends MessageBlock>(block: T): T {
  if (block.kind !== "ask" || !block.approvalEffectId || !block.actions) return block;
  return {
    ...block,
    actions: block.actions.map((action) =>
      action.id === "deny" ? { ...action, label: approvalDenyLabel("slack") } : action,
    ),
  };
}
