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

/** Components that take input. `DateTimeInput`, `CheckBox` and `ChoicePicker` included. */
const CONTROL_COMPONENTS = new Set([
  "TextField",
  "DateTimeInput",
  "CheckBox",
  "ChoicePicker",
  "TextFieldRow",
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
 * True when it was presented as something to confirm but stored nothing to confirm with.
 * The card says so and offers the way forward instead of leaving the sentence unanswered.
 */
export function needsRecovery(messages: readonly unknown[] | undefined): boolean {
  const { editable, actionable } = surfaceAffordances(messages);
  return !editable && !actionable;
}
