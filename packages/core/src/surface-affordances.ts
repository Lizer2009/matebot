import { isActionIntent } from "./interaction-capability.js";

/**
 * What a stored surface document can actually do.
 *
 * A card compiled by this build has real controls and an action button. A card compiled
 * by the first version of the compiler has neither: it drew a title and two lines of
 * text. Both are still in history, and the conversation around the older one says
 * "confirm in the card above" — a sentence nothing on that card could satisfy.
 *
 * The card cannot grow a button that was never stored, and it must not pretend the
 * button is there. It can say what is missing and what the person may do instead, which
 * is what this decides.
 */
export type SurfaceAffordances = {
  /** A text, choice or date control the person can edit. */
  editable: boolean;
  /** A button that submits the card. */
  actionable: boolean;
};

/**
 * Components that take input, by the names both compilers and the native catalog use.
 * `Slider` is in the basic catalog the web renderer allows, so it counts too.
 */
const CONTROL_COMPONENTS = new Set([
  "TextField",
  "DateTimeInput",
  "CheckBox",
  "ChoicePicker",
  "Slider",
]);

/** Components that submit. `Button` carries the action a card is confirmed with. */
const ACTION_COMPONENTS = new Set(["Button"]);

type ComponentRecord = { component?: unknown };

function componentsOf(messages: readonly unknown[]): ComponentRecord[] {
  const found: ComponentRecord[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const update = (message as { updateComponents?: { components?: unknown } }).updateComponents;
    if (!Array.isArray(update?.components)) continue;
    for (const component of update.components) {
      if (component && typeof component === "object") found.push(component as ComponentRecord);
    }
  }
  return found;
}

/**
 * Whether a document offers anything a person can fill in or press.
 *
 * Unknown or malformed documents report both false, which makes the card say it has
 * nothing to act on rather than implying a control it cannot draw.
 */
export function surfaceAffordances(messages: readonly unknown[] | undefined): SurfaceAffordances {
  if (!messages || messages.length === 0) return { editable: false, actionable: false };
  let editable = false;
  let actionable = false;
  for (const component of componentsOf(messages)) {
    const name = typeof component.component === "string" ? component.component : "";
    if (CONTROL_COMPONENTS.has(name)) editable = true;
    if (ACTION_COMPONENTS.has(name)) actionable = true;
  }
  return { editable, actionable };
}

/**
 * Whether a card is a read-only record wearing a draft's clothes.
 *
 * True only for a card that was *presented as something to confirm* — a form intent —
 * and stored nothing to confirm with. A result card is deliberately read-only: it is a
 * table of values with no controls by design, so calling it broken would nag the reader
 * about a card that works.
 *
 * `undefined` means the document is unknown (still loading, or a fetch that failed).
 * That is not evidence of an old card either, so it reports false and the caller shows
 * its own loading or error state.
 */
export function needsRecovery(
  messages: readonly unknown[] | undefined,
  options: { intent?: string } = {},
): boolean {
  if (!messages || messages.length === 0) return false;
  // A result is read-only on purpose; only a draft promises something to confirm.
  if (options.intent && !isActionIntent(options.intent)) return false;
  const { editable, actionable } = surfaceAffordances(messages);
  return !editable && !actionable;
}
