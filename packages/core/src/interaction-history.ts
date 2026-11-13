import { findInteractionCapability } from "./interaction-capability.js";

/**
 * The parenthetical a later turn reads after `intent → status`.
 *
 * Status lives on the block. Slots live on the interaction row. The projector
 * only sees the block, so publish stamps the few fields the registry names.
 */
export function cardHistoryDigest(input: {
  intent?: string;
  historySlots?: Record<string, string>;
  fallback?: string;
}): string | undefined {
  const slots = input.historySlots;
  const capability = input.intent ? findInteractionCapability(input.intent) : undefined;
  const names = capability?.historyDigestFields;
  if (slots && names?.length) {
    const parts: string[] = [];
    const labels = new Map(capability?.schema.fields.map((field) => [field.name, field.label]));
    for (const name of names) {
      const value = slots[name]?.trim();
      if (!value) continue;
      parts.push(`${labels.get(name) ?? name} ${value}`);
    }
    if (parts.length) return parts.join(" · ");
  }
  const fallback = input.fallback?.trim();
  return fallback || undefined;
}
