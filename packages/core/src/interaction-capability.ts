import type { InteractionSurfaceSchema } from "@matebot/contracts";
import type { InteractionRequiredApp } from "./interaction-connection.js";

/**
 * L1 capability registry: the server's list of what an A2UI surface may do.
 *
 * The model proposes an intent and values. This table is what decides whether
 * that proposal is a real capability at all, which fields it may carry, whether
 * it needs an app connection, and which effect (if any) its button runs. An
 * intent absent here has no surface and no action — callers fall back safely
 * instead of rendering a card that cannot work.
 *
 * Extend-first: no new table. The entry is keyed by intent, and the persisted
 * interaction already stores the intent it was created with.
 */

export type InteractionCapability = {
  intent: string;
  /** Short human label, used in prompts and fallbacks. */
  label: string;
  /** The schema the compiler turns into controls. */
  schema: InteractionSurfaceSchema;
  /**
   * The app that must be connected before the action runs. `null` means the
   * capability works with no remote connection — a local read, for example.
   */
  requiresConnection: InteractionRequiredApp | null;
  /** ExternalEffect kind the action creates, or null for a read-only surface. */
  effectKind: "email.send" | "calendar.create" | null;
  /** Read-only capabilities may render a result without any connection. */
  readOnly: boolean;
  /**
   * False while a stage still owes this capability its editor or effect. The
   * registry lists the intent so it is recognized, not so it is executable.
   */
  implemented: boolean;
};

const EMAIL_SCHEMA: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true, maxLength: 320 },
    { name: "cc", label: "CC", kind: "text", required: false, maxLength: 320 },
    { name: "subject", label: "Subject", kind: "text", required: true, maxLength: 400 },
    { name: "body", label: "Message", kind: "longText", required: true, maxLength: 20_000 },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

/**
 * Registered so a calendar plan cannot silently render as a text-only card, but
 * Phase 1 owns its editor and its submit, so the entry is intentionally
 * incomplete: `implemented: false` and no action. The dispatch path refuses any
 * action for it, and the hosts fall back rather than showing a dead button.
 */
const CALENDAR_SCHEMA: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "result",
  fields: [
    { name: "name", label: "Name", kind: "text", required: true, maxLength: 200 },
    { name: "start", label: "Starts", kind: "dateTime", required: false },
  ],
  action: null,
};

/**
 * A read-only result surface. Registered to prove the rule that a local or
 * read-only capability needs no connection; it has no action and no effect.
 */
const RESULT_SCHEMA: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "result",
  fields: [],
  action: null,
};

export const INTERACTION_CAPABILITIES: readonly InteractionCapability[] = [
  {
    intent: "email.compose",
    label: "Email",
    schema: EMAIL_SCHEMA,
    requiresConnection: "email",
    effectKind: "email.send",
    readOnly: false,
    implemented: true,
  },
  {
    intent: "calendar.create",
    label: "Calendar",
    schema: CALENDAR_SCHEMA,
    requiresConnection: "calendar",
    effectKind: "calendar.create",
    readOnly: false,
    implemented: false,
  },
  {
    intent: "interaction.result",
    label: "Result",
    schema: RESULT_SCHEMA,
    requiresConnection: null,
    effectKind: null,
    readOnly: true,
    implemented: true,
  },
] as const;

const BY_INTENT = new Map(INTERACTION_CAPABILITIES.map((entry) => [entry.intent, entry]));

/** The capability for an intent, or undefined when nothing is registered. */
export function findInteractionCapability(intent: string): InteractionCapability | undefined {
  return BY_INTENT.get(intent);
}

export function interactionCapabilityForIntent(intent: string): InteractionCapability | undefined {
  return findInteractionCapability(intent);
}

/** Every registered intent, for prompts and docs to stay in sync with code. */
export function interactionIntents(): string[] {
  return INTERACTION_CAPABILITIES.map((entry) => entry.intent);
}
