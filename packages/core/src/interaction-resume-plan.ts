/**
 * What a needs_connection card stores so reconnect can restore it in place
 * without asking the model (spec §5.5). Account identity is required: a
 * provider name alone would reconnect the wrong mailbox when two accounts
 * exist.
 */
export type InteractionResumePlan = {
  provider: string;
  accountId: string;
  displayEmail: string;
  intent: string;
  slots: Record<string, unknown>;
};

export function resumePlanFrom(plan: unknown): InteractionResumePlan | undefined {
  if (!plan || typeof plan !== "object" || !("resumePlan" in plan)) return undefined;
  const raw = (plan as { resumePlan?: unknown }).resumePlan;
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.intent !== "string" || !record.intent.trim()) return undefined;
  return {
    provider: typeof record.provider === "string" ? record.provider : "",
    accountId: typeof record.accountId === "string" ? record.accountId : "",
    displayEmail: typeof record.displayEmail === "string" ? record.displayEmail : "",
    intent: record.intent.trim(),
    slots:
      record.slots && typeof record.slots === "object" && !Array.isArray(record.slots)
        ? (record.slots as Record<string, unknown>)
        : {},
  };
}

export function planWithResumePlan<T extends Record<string, unknown>>(
  plan: T,
  resumePlan: InteractionResumePlan | undefined,
): T {
  if (!resumePlan) return plan;
  return { ...plan, resumePlan };
}

/** Build the stored resume plan for a needs_connection card (spec §5.5). */
export function resumePlanForNeedsConnection(input: {
  intent: string;
  slots: Record<string, unknown>;
  connection?: { id: string; provider: string; displayName: string };
  senderAddress?: string;
}): InteractionResumePlan {
  return {
    provider: input.connection?.provider ?? "",
    accountId: input.connection?.id ?? "",
    displayEmail: input.senderAddress?.trim() || input.connection?.displayName || "",
    intent: input.intent,
    slots: input.slots,
  };
}
