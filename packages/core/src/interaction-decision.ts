import type { InteractionDecision } from "@matebot/contracts";
import { InteractionDecisionSchema } from "@matebot/contracts";
import type { InteractionCapability } from "./interaction-capability.js";
import { cardKindForIntent, findInteractionCapability } from "./interaction-capability.js";

/**
 * Spec §6.3 — the structured decision the model proposes before a surface exists.
 *
 * This is deliberately *not* an authorization. The model says what it believes
 * the user wants and which capability it chose; the server decides whether that
 * capability exists, is implemented, and may render. Keeping the decision as
 * data means an unregistered candidate is refused with a reason instead of
 * becoming a card, and the choice can be replayed and audited.
 */

export type DecisionVerdict =
  | { ok: true; decision: InteractionDecision; capability: InteractionCapability }
  | { ok: false; error: "unknown_capability" | "invalid_decision" };

/**
 * The server's ruling on a proposed decision: the first candidate that is a
 * registered, implemented capability wins. Nothing about the string the model
 * wrote grants permission.
 */
export function validateDecisionForCapability(input: unknown): DecisionVerdict {
  const parsed = InteractionDecisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_decision" };
  const decision = parsed.data;
  for (const candidate of decision.capabilityCandidates) {
    const capability = findInteractionCapability(candidate);
    if (capability?.implemented) return { ok: true, decision, capability };
  }
  return { ok: false, error: "unknown_capability" };
}

export type PresentationDecision =
  | { presentation: "form"; reason: "ready" | "missing_fields"; ask?: string[] }
  | { presentation: "text"; reason: "source_unavailable" }
  | { presentation: "progress"; reason: "needs_connection" }
  | { presentation: "result"; reason: "ready" };

/**
 * Which surface a decision should produce.
 *
 * Order matters and follows the spec: a missing data source never renders a
 * result that looks like data; a missing connection asks to connect rather than
 * showing an action that would fail; missing required fields ask for them.
 */
export function decidePresentation(input: {
  capabilityIntent: string;
  missingFields: readonly string[];
  sourceAvailable: boolean;
  connectionReady: boolean;
}): PresentationDecision {
  if (!input.sourceAvailable && cardKindForIntent(input.capabilityIntent) === "result") {
    return { presentation: "text", reason: "source_unavailable" };
  }
  if (!input.connectionReady) {
    return { presentation: "progress", reason: "needs_connection" };
  }
  if (input.missingFields.length > 0) {
    return { presentation: "form", reason: "missing_fields", ask: [...input.missingFields] };
  }
  const capability = findInteractionCapability(input.capabilityIntent);
  return capability?.schema.presentation === "result"
    ? { presentation: "result", reason: "ready" }
    : { presentation: "form", reason: "ready" };
}

/** What to tell the user when the model's decision named nothing registered. */
export function unknownCapabilityNotice(): string {
  return "这个请求还没有对应的界面能力，我会继续在对话里处理。";
}
