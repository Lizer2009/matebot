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
 * What the server can say about a result's window, from the person's own words.
 *
 * - `stated`: the person named a period, so the window is theirs.
 * - `assumed`: the model said it chose the window. That is allowed, but only when
 *   said out loud: the card and the reply both carry the assumption.
 * - `unstated`: nobody said. The model presented a window the person never gave
 *   and did not admit choosing it, which is the defect the audit found. The turn
 *   asks instead of publishing a figure for a period the person never asked about.
 */
export type WindowDecision = "stated" | "assumed" | "unstated";

export function windowDecision(input: {
  claimedByModel: boolean;
  userPrompt: string | null | undefined;
}): WindowDecision {
  // An admission always wins: saying "I chose these dates" is the safe direction,
  // even when the person also named a period.
  if (input.claimedByModel) return "assumed";
  return promptStatesPeriod(input.userPrompt) ? "stated" : "unstated";
}

/**
 * Whether the assistant should ask for the missing period instead of publishing.
 *
 * A window nobody stated and nobody admitted choosing is not labelled and shown:
 * the answer would put a figure on a period the person never asked about. A window
 * the model openly chose is still shown, because it disclosed the choice itself.
 */
export function windowNeedsAsking(input: {
  claimedByModel: boolean;
  userPrompt: string | null | undefined;
}): boolean {
  return windowDecision(input) === "unstated";
}
