import type { InteractionCapability } from "./interaction-capability.js";

const OBJECT_MAX = 48;

/** Strip control characters and bound the object a button may name. */
export function sanitizeSurfaceObject(title: string | undefined): string {
  if (!title) return "";
  let withoutControls = "";
  for (const char of title) {
    const code = char.charCodeAt(0);
    withoutControls += code < 32 || code === 127 ? " " : char;
  }
  const cleaned = withoutControls.replace(/\s+/g, " ").trim();
  if (cleaned.length <= OBJECT_MAX) return cleaned;
  return `${cleaned.slice(0, OBJECT_MAX)}…`;
}

function capitalizeVerb(verb: string): string {
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/**
 * The button label: a registry verb plus the card's own title.
 *
 * The model's plan is values, never words on a control. No declared verb means no label.
 */
export function surfaceActionLabel(input: {
  capability: InteractionCapability;
  title?: string;
}): string | undefined {
  if (!input.capability.actionVerb) return undefined;
  const verb = capitalizeVerb(input.capability.actionVerb);
  const object = sanitizeSurfaceObject(input.title);
  return object ? `${verb} ${object}` : verb;
}
