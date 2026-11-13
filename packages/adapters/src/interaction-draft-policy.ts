import { isActionIntent } from "@matebot/core";

export type DraftApprovalDecision = "allow" | "ask" | "deny";

/**
 * Whether present_interaction should omit the compose card (spec §5.4.1).
 *
 * Closing drafts does not relax approval: deny and ask still need a person.
 * A connection card is not a draft, so it still appears.
 */
export function shouldSkipDraftCard(input: {
  draftsDisabled: boolean;
  intent: string;
  approval: DraftApprovalDecision;
  status?: string;
}): boolean {
  if (!input.draftsDisabled) return false;
  if (!isActionIntent(input.intent)) return false;
  if (input.status === "needs_connection") return false;
  return input.approval === "allow";
}
