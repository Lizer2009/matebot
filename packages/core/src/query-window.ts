/**
 * Whether the person actually named the period a result covers.
 *
 * The audit's flight answer said "默认按 11月9日去 / 11月16日回" and then reported
 * figures for that window as though it were the question. Disclosing a default in
 * prose is not the same as the card carrying it, and trusting the model to say it
 * defaults the very thing that went wrong to the party that got it wrong.
 *
 * So the server decides from the user's own words. This is a *floor*, not a reading
 * of the request: it recognises the shapes a period is normally written in and says
 * nothing about anything else. The two mistakes are not equally costly. Treating a
 * stated period as unstated asks a needless question; treating an unstated period as
 * stated is the defect itself, so every pattern here is deliberately narrow and an
 * unrecognised prompt falls to "unstated" — the direction that asks.
 *
 * This is not a substitute for understanding the request. A model that follows the
 * rule discloses its own choice through `defaultedWindow`, which is honoured whatever
 * these patterns say; they only decide the case where nobody admitted anything.
 */

/** A date the person typed: ISO, slash form, a day-of-month, or a month with a day. */
const STATED_DATE = [
  // 2026-11-09 or 2026/11/09
  /\b\d{4}[-/]\d{1,2}([-/]\d{1,2})?\b/,
  // 11/9 or 11/9/2026
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  // 11月9日, 十二月, 12月
  /\d{1,2}\s*月(\s*\d{1,2}\s*[日号])?/,
  /(十[一二]?|正)月/,
  // 9日 / 9号 on its own is a day of the month.
  /\b\d{1,2}\s*[日号]/,
  // "November 9" or "9 November" — a month name with a day beside it. A month name
  // alone is not enough: "May I see the draft" is not a period.
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}\b/i,
  /\b\d{1,2}\s+(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i,
  /\bin\s+(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i,
];

/** A period named in words, which bounds the question as well as a date does. */
const STATED_PERIOD = [
  // this/next/last week, past 7 days, the last 2 weeks
  /\b(this|next|last|past|previous|coming)\s+(\d+\s+)?(day|week|month|quarter|year)s?\b/i,
  /\b(today|tomorrow|yesterday|tonight|this morning|this afternoon)\b/i,
  // Q2, Q2 2026, FY2026
  /\bq[1-4](\s*\d{4})?\b/i,
  /\bfy\s*\d{2,4}\b/i,
  /\b(last|next|this|past)\s+(few|couple)\s+(day|week|month)s?\b/i,
  // 本周 / 下周, 今天, 今年, 上季度, 过去7天, 最近三个月, 第2季度
  /本周|这周|下周|上周|这个月|本月|上个月|下个月|这季度|本季度|上季度|下季度|今年|去年|明年|今天|明天|昨天|前天|今晚/,
  /(过去|最近|近)\s*(\d+\s*)?(天|周|个月|月|年|季度)/,
  /第\s*[1-4一二三四]\s*季度/,
];

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
  return (
    STATED_DATE.some((pattern) => pattern.test(text)) ||
    STATED_PERIOD.some((pattern) => pattern.test(text))
  );
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
