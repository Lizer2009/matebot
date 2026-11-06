import type { InteractionCapability } from "./interaction-capability.js";
import { findInteractionCapability } from "./interaction-capability.js";

/**
 * Turns an intent the model proposed into something the server will actually
 * render, or an explicit reason it will not.
 *
 * The important half is the refusal. A plan naming an intent that is not in the
 * capability registry must not reach the compiler, because the compiler would
 * happily emit a schema-less card. Callers get a reason and a safe fallback line
 * instead, so the chat says "no interface for this" rather than showing a control
 * that cannot work.
 */

export type SurfacePlan =
  | { ok: true; capability: InteractionCapability }
  | { ok: false; reason: "unregistered_intent" | "not_implemented" };

export function surfacePlanForCapability(intent: string): SurfacePlan {
  const capability = findInteractionCapability(intent);
  if (!capability) return { ok: false, reason: "unregistered_intent" };
  // Registered only so it is recognized; its stage still owes an editor.
  if (!capability.implemented) return { ok: false, reason: "not_implemented" };
  return { ok: true, capability };
}

/**
 * The line a host shows in place of a surface it cannot build. Deliberately a
 * plain sentence with no action: the user must not read it as "done", and the
 * model must not be nudged into claiming a side effect.
 */
export function surfaceFallback(intent: string): { kind: "text"; text: string; reason: string } {
  const capability = findInteractionCapability(intent);
  if (!capability) {
    return {
      kind: "text",
      reason: "unregistered_intent",
      text: `This request (${intent}) has no interactive interface yet, so it will continue in the chat rather than on a card.`,
    };
  }
  return {
    kind: "text",
    reason: "not_implemented",
    text: `The ${capability.label.toLowerCase()} interface is not available yet, so this stays in the chat for now.`,
  };
}
