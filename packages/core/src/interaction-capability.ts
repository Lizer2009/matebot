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

/** Which heading shape a card of this capability uses (§6.4). */
export type SurfaceCardShape = "review" | "decision";

/** The one verb a button may use. Never taken from the model's plan. */
export type SurfaceActionVerb = "send" | "create";

/**
 * Whether a capability occupies the one-open-card unique index.
 *
 * `action` cards are drafts the kernel publishes; only one may be open per
 * thread+intent. `result` cards enter already terminal, so the index does not
 * apply (spec §5.6).
 */
export type CardKind = "action" | "result";

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
  effectKind: string | null;
  /** Read-only capabilities may render a result without any connection. */
  readOnly: boolean;
  /**
   * False while a stage still owes this capability its editor or effect. The
   * registry lists the intent so it is recognized, not so it is executable.
   */
  implemented: boolean;
  /** Which heading shape a card of this capability uses (§6.4). */
  cardShape: SurfaceCardShape;
  /** The one verb its button may use. Never taken from the model's plan. */
  actionVerb?: SurfaceActionVerb;
  /**
   * Slot names a later turn must see in history (spec §6.7.1). Empty means the
   * projector falls back to title/summary.
   */
  historyDigestFields?: readonly string[];
  /** Action drafts vs terminal result cards (spec §5.6). */
  cardKind: CardKind;
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
 * Phase 1: the calendar create draft.
 *
 * It is a real form with a real submit, not a copy of the email templates: the
 * shared lifecycle, action bridge, revision writer and dispatch do the work, and
 * the calendar-specific parts live in `calendar-event.ts` (start/end ordering,
 * timezone, all-day snap). Attendees are deliberately not collected, so a create
 * can never invite anyone by accident.
 */
const CALENDAR_SCHEMA: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "name", label: "Name", kind: "text", required: true, maxLength: 200 },
    { name: "start", label: "Starts", kind: "dateTime", required: true },
    { name: "end", label: "Ends", kind: "dateTime", required: true },
    { name: "timezone", label: "Time zone", kind: "text", required: false, maxLength: 64 },
    { name: "allDay", label: "All day", kind: "boolean", required: false },
  ],
  action: { id: "create", label: "Create", requiresRevision: true },
};

/**
 * Reading a schedule is a different capability from writing one. A query renders
 * a result surface with no action, so "what is next week" can never turn into a
 * silent create.
 */
const CALENDAR_QUERY_SCHEMA: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "result",
  fields: [],
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
    cardShape: "review",
    actionVerb: "send",
    historyDigestFields: ["to", "subject"],
    cardKind: "action",
  },
  {
    intent: "calendar.create",
    label: "Calendar",
    schema: CALENDAR_SCHEMA,
    requiresConnection: "calendar",
    effectKind: "calendar.create",
    readOnly: false,
    implemented: true,
    cardShape: "review",
    actionVerb: "create",
    historyDigestFields: ["name", "start", "end"],
    cardKind: "action",
  },
  {
    intent: "calendar.query",
    label: "Schedule",
    schema: CALENDAR_QUERY_SCHEMA,
    requiresConnection: "calendar",
    effectKind: null,
    readOnly: true,
    implemented: true,
    cardShape: "review",
    cardKind: "result",
  },
  {
    intent: "interaction.result",
    label: "Result",
    schema: RESULT_SCHEMA,
    requiresConnection: null,
    effectKind: null,
    readOnly: true,
    implemented: true,
    cardShape: "review",
    cardKind: "result",
  },
] as const;

const BY_INTENT = new Map(INTERACTION_CAPABILITIES.map((entry) => [entry.intent, entry]));

/**
 * Older spellings that mean a registered intent. Lookups stay keyed by the
 * registered name; callers canonicalize first so `email.send` is not a second
 * card kind.
 */
export const INTENT_ALIASES: Readonly<Record<string, string>> = {
  "email.send": "email.compose",
  "calendar.compose": "calendar.create",
};

/** Map an alias or registered intent onto the registry key. */
export function canonicalIntent(intent: string): string {
  return INTENT_ALIASES[intent] ?? intent;
}

/** The capability for an intent, or undefined when nothing is registered. */
export function findInteractionCapability(intent: string): InteractionCapability | undefined {
  return BY_INTENT.get(intent);
}

export function interactionCapabilityForIntent(intent: string): InteractionCapability | undefined {
  return findInteractionCapability(intent);
}

/** Action vs result for a registered intent or its alias. */
export function cardKindForIntent(intent: string): CardKind | undefined {
  return findInteractionCapability(canonicalIntent(intent))?.cardKind;
}

export function isActionIntent(intent: string | undefined): boolean {
  return intent !== undefined && cardKindForIntent(intent) === "action";
}

export function isEmailComposeIntent(intent: string | undefined): boolean {
  return intent !== undefined && canonicalIntent(intent) === "email.compose";
}

export function isCalendarCreateIntent(intent: string | undefined): boolean {
  return intent !== undefined && canonicalIntent(intent) === "calendar.create";
}

/** Every registered intent, for prompts and docs to stay in sync with code. */
export function interactionIntents(): string[] {
  return INTERACTION_CAPABILITIES.map((entry) => entry.intent);
}
