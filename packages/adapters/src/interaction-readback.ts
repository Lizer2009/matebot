import type { InteractionPlan } from "@matebot/contracts";
import type { EmailSurfaceCapability } from "@matebot/core";

/**
 * What the model is told about a card, in terms it can act on.
 *
 * The audit found a model telling someone their recipient, subject and body were all filled in
 * while the card on screen had no controls in it. Nothing had told it what the card became, so
 * it described the plan it had submitted. A tool result that names the fields, their values, the
 * gaps and whether the action is available removes the guess.
 *
 * Two things are deliberately absent. Provider references and connection ids never appear: the
 * model would repeat them into the transcript, and they are not something the person can read off
 * the card. The sending address does appear, but as `sender` beside the fields rather than as one
 * of them — it is decided by the connected mailbox, so offering it as editable would invite an
 * edit that cannot be honoured.
 */

export type DraftFieldReadback = {
  name: string;
  /** What the card shows: the stored value as text, or empty. */
  value: string;
  required: boolean;
  filled: boolean;
};

export type DraftReadback = {
  /** The version the next `edit_interaction` has to quote. */
  revision: number;
  fields: DraftFieldReadback[];
  /** Required fields with nothing in them yet. */
  missingRequired: string[];
  /** Whether the card's action can run now. */
  actionable: boolean;
  /** What stands in the way: empty field names, or `connection`. */
  blockedBy: string[];
  /** The mailbox this draft would send from, when a connection names one. */
  sender?: { address: string; label: string };
};

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isEmpty(value: string): boolean {
  return value.trim() === "";
}

export function describeDraftForModel(input: {
  plan: InteractionPlan;
  slots: Record<string, unknown>;
  draftVersion: number;
  capability?: EmailSurfaceCapability;
  sender?: { address: string; label: string };
}): DraftReadback {
  // The plan is the authority on which fields the card shows. A slot the plan does not name is
  // data the action reads, not something the model should describe as a field.
  const fields: DraftFieldReadback[] = input.plan.fields.map((field) => {
    const value = asText(input.slots[field.name] ?? field.value);
    return { name: field.name, value, required: field.required, filled: !isEmpty(value) };
  });
  const missingRequired = fields
    .filter((field) => field.required && !field.filled)
    .map((field) => field.name);

  const blockedBy = [...missingRequired];
  // A complete draft still cannot be sent without a mailbox, and saying it can would send the
  // model back to telling the person to press a button that refuses.
  if (input.capability === "not_connected" || input.capability === "requires_reauth") {
    blockedBy.push("connection");
  }

  return {
    revision: input.draftVersion,
    fields,
    missingRequired,
    actionable: blockedBy.length === 0,
    blockedBy,
    ...(input.sender ? { sender: input.sender } : {}),
  };
}
