import type { InteractionPlan } from "@matebot/contracts";
import type { EmailSurfaceCapability } from "@matebot/core";
import { interactionCapabilityForIntent, readConfirmedCalendarDraft } from "@matebot/core";

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
  sender?: DraftSender;
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

export type DraftSender = {
  /**
   * The mailbox address, only when the server learned it from the provider's own record of the
   * account. `Connection.displayName` is not that: it is whatever the client passed when the
   * connection was created (a card title, an app name), so it can be a nickname or a label and
   * must never be presented as the address a message will come from.
   */
  address?: string;
  /** What the connection calls itself. Always safe to show; never a claim about the address. */
  label: string;
};

export function describeDraftForModel(input: {
  plan: InteractionPlan;
  slots: Record<string, unknown>;
  draftVersion: number;
  capability?: EmailSurfaceCapability;
  sender?: DraftSender;
  /** The lifecycle, so a settled card is never described as actionable. */
  lifecycle?: string;
  interactionStatus?: string;
}): DraftReadback {
  // The plan is the authority on which fields the card shows. A slot the plan does not name is
  // data the action reads, not something the model should describe as a field.
  //
  // A stored plan can still carry fields the registered schema does not declare: a calendar
  // batch list is kept as data for the action, and an older row may still hold a `from`. Those
  // never become controls, so reporting them would tell the model there are fields nobody can
  // edit. The schema, when the intent has one, decides what the card has — including when it
  // declares no fields at all, as a read-only result surface does. Only an unregistered intent
  // falls back to the plan's own list.
  const schema = interactionCapabilityForIntent(input.plan.intent)?.schema;
  const declared = new Map((schema?.fields ?? []).map((field) => [field.name, field.required]));
  const surfaces = schema
    ? input.plan.fields.filter((field) => declared.has(field.name))
    : input.plan.fields;
  const fields: DraftFieldReadback[] = surfaces.map((field) => {
    const value = asText(input.slots[field.name] ?? field.value);
    return {
      name: field.name,
      value,
      // The schema owns requiredness, so a row that recorded a stale `required: false` for a
      // field the schema requires is not reported as optional.
      required: declared.get(field.name) ?? field.required,
      filled: !isEmpty(value),
    };
  });
  // A calendar batch is several events held in `events`; the single-event start and end are
  // empty on purpose. Counting them as gaps told the model its complete card was incomplete,
  // and it filled a week-long placeholder event to satisfy them.
  const batchCoversSingleSlots =
    (input.plan.intent === "calendar.create" || input.plan.intent === "calendar.compose") &&
    readConfirmedCalendarDraft(input.slots).kind === "batch";
  const missingRequired = fields
    .filter((field) => field.required && !field.filled)
    .map((field) => field.name)
    .filter((name) => !(batchCoversSingleSlots && (name === "start" || name === "end")));

  const blockedBy = [...missingRequired];
  // A draft that has already settled cannot be acted on again, whatever its fields say. Saying
  // otherwise would send the model back to telling the person to press a button that refuses.
  const settled =
    input.lifecycle !== undefined &&
    ["succeeded", "failed", "unknown", "cancelled"].includes(input.lifecycle);
  const terminalStatus =
    input.interactionStatus !== undefined &&
    ["cancelled", "executing", "succeeded", "unknown", "failed"].includes(input.interactionStatus);
  if (settled || terminalStatus) blockedBy.push("lifecycle");
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

/**
 * Read a draft back from what was stored, with the mailbox state that applies to it.
 *
 * Present and edit both call this after they write, so the two can never describe the same card
 * differently, and neither describes the request it sent. The capability and the sender come from
 * the same connection lookup the publish path uses, so a card cannot claim it can send while the
 * mailbox behind it is gone.
 */
export function readbackFromStored(input: {
  plan: InteractionPlan;
  slots: Record<string, unknown>;
  draftVersion: number;
  capability?: EmailSurfaceCapability;
  sender?: DraftSender;
  lifecycle?: string;
  interactionStatus?: string;
}): DraftReadback {
  return describeDraftForModel(input);
}
