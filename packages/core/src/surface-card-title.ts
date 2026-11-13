import type { InteractionCapability, SurfaceCardShape } from "./interaction-capability.js";
import { sanitizeSurfaceObject } from "./surface-action-label.js";

/**
 * The heading a card shows: a review card is "category + content"; a decision card is a
 * question. The model's plan never supplies this sentence.
 */
export function surfaceCardTitle(input: { capability: InteractionCapability; title?: string }): {
  category?: string;
  title: string;
  shape: SurfaceCardShape;
} {
  const shape = input.capability.cardShape;
  const object = sanitizeSurfaceObject(input.title);
  if (shape === "decision") {
    const body = object.replace(/^(添加|add)\s+/i, "") || object;
    return { title: `Add ${body}?`, shape };
  }
  return {
    category: input.capability.label,
    title: object || input.capability.label,
    shape,
  };
}
