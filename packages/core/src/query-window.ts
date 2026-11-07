import type { InteractionDecision } from "@matebot/contracts";

/**
 * Whether the person actually named the period a result covers.
 *
 * The audit's flight answer said "默认按 11月9日去 / 11月16日回" and then reported
 * figures for that window as though it were the question. Disclosing a default in
 * prose is not the same as the card carrying it, and trusting the model to say it
 * defaults the very thing that went wrong to the party that got it wrong.
 *
 * So the server decides from the user's own words. This is deliberately narrow: it
 * looks for a date the person wrote, or an explicit period they named. It does not
 * try to understand the request; it only answers "was a period stated at all",
 * because the consequence of being wrong is asymmetric — saying "we assumed the
 * dates" when the user did state them is a small annoyance, while presenting an
 * invented period as their choice is the defect being fixed.
 */

/** A date the person typed: ISO, slash form, or a month/day pair. */
const STATED_DATE =
  /\b\d{4}-\d{1,2}(-\d{1,2})?\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b\d{1,2}\s*(月|日)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/** A period named in words, which is as specific as a date for this purpose. */
const STATED_PERIOD =
  /\b(this|next|last)\s+(week|month|quarter|year)\b|\b(today|tomorrow|yesterday|tonight)\b|本周|下周|上周|这个月|上个月|下个月|这季度|上季度|本季度|今年|去年|今天|明天|昨天|\d+\s*(天|周|个月)\b/i;

/**
 * Whether the prompt names a period itself.
 *
 * A relative phrase such as "next week" counts: the person bounded the question,
 * even if the assistant still has to choose exact dates within it. What does not
 * count is asking about something with no period at all.
 */
export function promptStatesPeriod(prompt: string | null | undefined): boolean {
  const text = (prompt ?? "").trim();
  if (!text) return false;
  return STATED_DATE.test(text) || STATED_PERIOD.test(text);
}

/**
 * Whether this result's window was chosen by the assistant.
 *
 * The model may say so itself; it may also be wrong, so a claim of "not defaulted"
 * is only accepted when the person's words actually support it. A claim of
 * "defaulted" is always accepted, because saying so is the safe direction.
 */
export function windowWasDefaulted(input: {
  claimedByModel: boolean;
  userPrompt: string | null | undefined;
}): boolean {
  if (input.claimedByModel) return true;
  return !promptStatesPeriod(input.userPrompt);
}

/**
 * The decision a result needs when its period was assumed and the person was not
 * asked. Used by callers that want to surface the clarification rather than only
 * label the card.
 */
export function defaultedWindowNeedsAsking(decision: InteractionDecision): boolean {
  return decision.missingFields.length > 0;
}
