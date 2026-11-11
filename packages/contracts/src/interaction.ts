import * as z from "zod";
import { Id } from "./ids.js";

/**
 * Vendor-neutral plan the model emits before the server compiles an A2UI surface.
 * See docs/architecture/matebot-a2ui-integration-design.md §8.4.
 */
export const InteractionFieldStatus = z.enum([
  "resolved",
  "missing",
  "needs_confirmation",
  "invalid",
]);
export type InteractionFieldStatus = z.infer<typeof InteractionFieldStatus>;

export const InteractionNextStep = z.enum([
  "render",
  "ask",
  "request_connection",
  "request_approval",
  "execute",
  "complete",
]);
export type InteractionNextStep = z.infer<typeof InteractionNextStep>;

export const InteractionRiskLevel = z.enum(["low", "medium", "high"]);
export type InteractionRiskLevel = z.infer<typeof InteractionRiskLevel>;

/**
 * Ceilings for a field the registered schema does not declare.
 *
 * An undeclared field is data the action reads (a calendar batch list), so it has to survive
 * into the stored plan — but nothing else bounds it: `value` is `unknown`, and a model-supplied
 * array or string would be written into the surface document and returned on every fetch. The
 * name limit keeps a plan from smuggling structure through the key, and the serialized limit
 * keeps one field from filling the row.
 */
export const MAX_INTERACTION_FIELD_NAME = 200;
export const MAX_UNDECLARED_FIELD_BYTES = 64 * 1024;

export const InteractionFieldSchema = z.object({
  name: z.string().trim().min(1).max(MAX_INTERACTION_FIELD_NAME),
  value: z.unknown().optional(),
  required: z.boolean(),
  status: InteractionFieldStatus,
  source: z.string().trim().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type InteractionField = z.infer<typeof InteractionFieldSchema>;

export const InteractionPlanSchema = z.object({
  intent: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().optional(),
  fields: z.array(InteractionFieldSchema),
  nextStep: InteractionNextStep,
  riskLevel: InteractionRiskLevel,
});
export type InteractionPlan = z.infer<typeof InteractionPlanSchema>;

/** Render family pin for catalog hosts; server adapter remains dual-track. */
export const A2uiProtocolFamily = z.enum(["v0_9", "v1_0"]);
export type A2uiProtocolFamily = z.infer<typeof A2uiProtocolFamily>;

/** Mailbox preflight stamp on email.compose surfaces. */
export const EmailSurfaceCapability = z.enum(["not_connected", "requires_reauth", "ready"]);
export type EmailSurfaceCapability = z.infer<typeof EmailSurfaceCapability>;

/** State-driven template id. Hosts prefer this over intent-only switching. */
export const EmailSurfaceTemplate = z.enum([
  "email-connection-card",
  "email-reauth-card",
  "email-draft-card",
  "action-submitting-card",
  "action-progress-card",
  "action-result-success",
  "action-result-failed",
  "action-reconcile-card",
]);
export type EmailSurfaceTemplate = z.infer<typeof EmailSurfaceTemplate>;

/** Execution lifecycle on the same surface. Omitted means draft. */
export const EmailSurfaceLifecycle = z.enum([
  "draft",
  "submitting",
  "executing",
  "succeeded",
  "failed",
  "unknown",
]);
export type EmailSurfaceLifecycle = z.infer<typeof EmailSurfaceLifecycle>;

/**
 * Timeline projection for a declarative interaction surface.
 * Prefer this single kind over proliferating business-specific draft cards.
 */
export const A2uiSurfaceBlockSchema = z.object({
  kind: z.literal("a2ui_surface"),
  interactionId: Id,
  surfaceId: z.string().trim().min(1),
  protocolFamily: A2uiProtocolFamily,
  draftVersion: z.number().int().positive(),
  /**
   * Set when the server has confirmed this exact draft.
   * Absent or unequal to draftVersion means the draft is not sendable.
   */
  confirmedVersion: z.number().int().positive().optional(),
  /** Plan intent, such as email.compose, so hosts can show a purpose-built editor. */
  intent: z.string().trim().min(1).optional(),
  /**
   * Mailbox preflight for email.compose surfaces.
   * Omitted on older events; hosts treat that as ready.
   */
  capability: EmailSurfaceCapability.optional(),
  /**
   * State-driven template id. Hosts prefer this over intent-only switching.
   * Omitted on older events; derive from capability + lifecycle.
   */
  template: EmailSurfaceTemplate.optional(),
  /** Execution lifecycle on the same surface. Omitted means draft. */
  lifecycle: EmailSurfaceLifecycle.optional(),
  /** Provider message id after a successful send. D′/E′ consume this. */
  providerMessageId: z.string().trim().min(1).optional(),
  /** Last send error when lifecycle is failed or unknown. */
  error: z.string().optional(),
  /**
   * The executed record this draft corrects. A correction is always a new draft
   * that points at what happened; the executed record itself never changes.
   */
  amendsInteractionId: z.string().trim().min(1).optional(),
  /** Short label for the timeline before/without the full catalog document. */
  title: z.string().optional(),
  summary: z.string().optional(),
  /**
   * What the sending connection calls itself, for a read-only row on the card.
   *
   * Deliberately a label and not an address: the connection's name is whatever the client passed
   * when it was created, so it can be a nickname. The card shows it as "sending from", never as
   * the mailbox address, and never as something the person can edit — the address is decided by
   * the connected mailbox.
   *
   * Bounded like the connection label itself. The connection row accepts any string at connect
   * time, and a title the model wrote can be long; a stored block that broke this bound would
   * fail to parse on the way out, taking the whole card with it.
   */
  senderLabel: z.string().trim().min(1).max(80).optional(),
  /**
   * Server-held document or patch pointer for later hydrate; not a client authority.
   * Prefer `a2uiSurfaceDocumentRef({ interactionId, surfaceId })` (PR-4 Option A).
   */
  documentRef: z.string().trim().min(1).optional(),
});
export type A2uiSurfaceBlock = z.infer<typeof A2uiSurfaceBlockSchema>;

/** Prefix for InteractionSurface document pointers (server tables; not mobile cache). */
export const A2UI_SURFACE_DOCUMENT_REF_PREFIX = "a2ui:interaction:" as const;

/** Build a documentRef that resolves via Interaction + InteractionSurface rows. */
export function a2uiSurfaceDocumentRef(input: {
  interactionId: string;
  surfaceId: string;
}): string {
  return `${A2UI_SURFACE_DOCUMENT_REF_PREFIX}${input.interactionId}:surface:${input.surfaceId}`;
}

/** Parse a PR-4 Option A documentRef; returns null for fixtures or unknown shapes. */
export function parseA2uiSurfaceDocumentRef(
  documentRef: string,
): { interactionId: string; surfaceId: string } | null {
  const trimmed = documentRef.trim();
  if (!trimmed.startsWith(A2UI_SURFACE_DOCUMENT_REF_PREFIX)) return null;
  const rest = trimmed.slice(A2UI_SURFACE_DOCUMENT_REF_PREFIX.length);
  const marker = ":surface:";
  const at = rest.indexOf(marker);
  if (at <= 0) return null;
  const interactionId = rest.slice(0, at).trim();
  const surfaceId = rest.slice(at + marker.length).trim();
  if (!interactionId || !surfaceId) return null;
  return { interactionId, surfaceId };
}

/** Suggested payload for thread.interaction.* ProductEvents (envelope stays loose). */
export const InteractionProductEventPayloadSchema = z.object({
  interactionId: Id,
  intent: z.string().trim().min(1).optional(),
  draftVersion: z.number().int().positive().optional(),
  confirmedVersion: z.number().int().positive().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  /** Aligns with ask / ExternalEffect when confirmation is required. */
  approvalEffectId: Id.optional(),
  messageId: Id.optional(),
  fieldName: z.string().trim().min(1).optional(),
  progress: z.string().optional(),
  error: z.string().optional(),
  template: z.string().trim().min(1).optional(),
  lifecycle: z.string().trim().min(1).optional(),
  providerMessageId: z.string().trim().min(1).optional(),
});
export type InteractionProductEventPayload = z.infer<typeof InteractionProductEventPayloadSchema>;

/** Suggested payload for thread.surface.* ProductEvents. */
export const SurfaceProductEventPayloadSchema = z.object({
  interactionId: Id,
  surfaceId: z.string().trim().min(1),
  protocolFamily: A2uiProtocolFamily,
  draftVersion: z.number().int().positive(),
  confirmedVersion: z.number().int().positive().optional(),
  intent: z.string().trim().min(1).optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  documentRef: z.string().trim().min(1).optional(),
  messageId: Id.optional(),
  capability: EmailSurfaceCapability.optional(),
  template: EmailSurfaceTemplate.optional(),
  lifecycle: EmailSurfaceLifecycle.optional(),
  providerMessageId: z.string().trim().min(1).optional(),
  error: z.string().optional(),
});
export type SurfaceProductEventPayload = z.infer<typeof SurfaceProductEventPayloadSchema>;

/**
 * Exactly one of botId / groupId — shared by threads.* RPC and interaction drafts.
 */
export const ThreadTargetSchema = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
  })
  .superRefine((input, ctx) => {
    const hasBot = Boolean(input.botId);
    const hasGroup = Boolean(input.groupId);
    if (hasBot === hasGroup) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
  });
export type ThreadTarget = z.infer<typeof ThreadTargetSchema>;

/**
 * Draft for a future `threads.updateInteractionField` (or answer extension).
 * Not mounted on appContract in PR-1 — stubs only so API handlers are not required.
 */
export const ThreadsUpdateInteractionFieldInput = ThreadTargetSchema.safeExtend({
  interactionId: Id,
  /** Client's view of the draft; server rejects if stale. */
  expectedDraftVersion: z.number().int().positive(),
  name: z.string().trim().min(1),
  value: z.unknown(),
});
export type ThreadsUpdateInteractionFieldInput = z.infer<typeof ThreadsUpdateInteractionFieldInput>;

export const ThreadsUpdateInteractionFieldOutput = z.object({
  ok: z.literal(true),
  draftVersion: z.number().int().positive(),
});
export type ThreadsUpdateInteractionFieldOutput = z.infer<
  typeof ThreadsUpdateInteractionFieldOutput
>;

/**
 * Draft for a future `threads.confirmInteraction`.
 * Sets confirmedVersion = draftVersion when the server accepts the current draft.
 */
export const ThreadsConfirmInteractionInput = ThreadTargetSchema.safeExtend({
  interactionId: Id,
  draftVersion: z.number().int().positive(),
  /** Optional ask message to keep approval UX aligned with threads.answer. */
  messageId: Id.optional(),
  runId: Id.optional(),
});
export type ThreadsConfirmInteractionInput = z.infer<typeof ThreadsConfirmInteractionInput>;

export const ThreadsConfirmInteractionOutput = z.object({
  ok: z.literal(true),
  confirmedVersion: z.number().int().positive(),
  /** ExternalEffect created or reused for this confirmed draft. */
  effectId: Id,
  idempotencyKey: z.string().min(1),
});
export type ThreadsConfirmInteractionOutput = z.infer<typeof ThreadsConfirmInteractionOutput>;

export const ThreadsCancelInteractionInput = ThreadTargetSchema.safeExtend({
  interactionId: Id,
  /** The revision the caller was looking at; a stale cancel is refused. */
  draftVersion: z.number().int().positive(),
});
export type ThreadsCancelInteractionInput = z.infer<typeof ThreadsCancelInteractionInput>;

export const ThreadsCancelInteractionOutput = z.object({
  ok: z.literal(true),
  status: z.literal("cancelled"),
  draftVersion: z.number().int().positive(),
});

/**
 * Execute a confirmed interaction. The server rejects the call when
 * confirmedVersion is missing or no longer matches draftVersion.
 */
export const ThreadsExecuteInteractionInput = ThreadTargetSchema.safeExtend({
  interactionId: Id,
});
export type ThreadsExecuteInteractionInput = z.infer<typeof ThreadsExecuteInteractionInput>;

export const ThreadsExecuteInteractionOutput = z.object({
  ok: z.literal(true),
  effectId: Id,
  idempotencyKey: z.string().min(1),
  /** True when a completed effect was returned instead of running again. */
  duplicate: z.boolean(),
  /** True once the effect's sender finished. False for kinds with no sender yet. */
  executed: z.boolean(),
  /** Present on a successful send so D′ can show the provider id without a second fetch. */
  providerMessageId: z.string().trim().min(1).optional(),
});
export type ThreadsExecuteInteractionOutput = z.infer<typeof ThreadsExecuteInteractionOutput>;

/** Inspect an UNKNOWN send. Does not deliver. */
export const ThreadsReconcileInteractionInput = ThreadsExecuteInteractionInput;
export type ThreadsReconcileInteractionInput = z.infer<typeof ThreadsReconcileInteractionInput>;

export const ThreadsReconcileInteractionOutput = z.object({
  ok: z.literal(true),
  effectId: Id,
  status: z.enum(["succeeded", "failed", "unknown"]),
  providerMessageId: z.string().trim().min(1).optional(),
});
export type ThreadsReconcileInteractionOutput = z.infer<typeof ThreadsReconcileInteractionOutput>;

/**
 * Hydrate a persisted A2UI surface document by documentRef or interaction+surface ids.
 * Server is authority; clients must not invent documents.
 */
export const ThreadsGetA2uiSurfaceInput = ThreadTargetSchema.safeExtend({
  documentRef: z.string().trim().min(1).optional(),
  interactionId: Id.optional(),
  surfaceId: z.string().trim().min(1).optional(),
}).superRefine((input, ctx) => {
  if (input.documentRef) return;
  if (input.interactionId && input.surfaceId) return;
  ctx.addIssue({
    code: "custom",
    message: "Provide documentRef or both interactionId and surfaceId",
    path: ["documentRef"],
  });
});
export type ThreadsGetA2uiSurfaceInput = z.infer<typeof ThreadsGetA2uiSurfaceInput>;

export const ThreadsGetA2uiSurfaceOutput = z.object({
  interactionId: Id,
  surfaceId: z.string().trim().min(1),
  protocolFamily: A2uiProtocolFamily,
  draftVersion: z.number().int().positive(),
  /** Compiled A2UI protocol messages. */
  messages: z.array(z.unknown()),
  documentRef: z.string().trim().min(1),
});
export type ThreadsGetA2uiSurfaceOutput = z.infer<typeof ThreadsGetA2uiSurfaceOutput>;

/**
 * Dispatch a compiled surface's action. The client may only echo what the
 * server rendered: the interaction, the surface, and the exact revision the
 * click came from. The server re-checks all three plus ownership before any
 * effect runs, so a stale or forged click cannot execute.
 */
export const ThreadsDispatchInteractionActionInput = ThreadTargetSchema.safeExtend({
  interactionId: Id,
  surfaceId: z.string().trim().min(1),
  /** The action id from the rendered button, e.g. "send". */
  action: z.string().trim().min(1).max(64),
  /** The draft revision this surface was rendered from. */
  revision: z.number().int().positive(),
});
export type ThreadsDispatchInteractionActionInput = z.infer<
  typeof ThreadsDispatchInteractionActionInput
>;

export const ThreadsDispatchInteractionActionOutput = z.object({
  ok: z.literal(true),
  /** True when this exact click had already run; nothing executed again. */
  duplicate: z.boolean(),
  interactionId: Id,
  revision: z.number().int().positive(),
});
export type ThreadsDispatchInteractionActionOutput = z.infer<
  typeof ThreadsDispatchInteractionActionOutput
>;

/**
 * Rejections a dispatch can produce. Returned as a controlled code rather than a
 * thrown 500 so the card can render the matching state instead of a dead end.
 */
export const InteractionDispatchError = z.enum([
  "stale_revision",
  "not_approved",
  "already_executed",
  "unknown_action",
  "unknown_surface",
  "unknown_interaction",
  "forbidden",
  "invalid_schema",
  "action_failed",
  /** The app the action needs is not connected, so the user must connect it before retrying. */
  "needs_connection",
]);
export type InteractionDispatchError = z.infer<typeof InteractionDispatchError>;

/**
 * Apply a model-proposed natural-language edit to an existing draft.
 *
 * The model supplies field values and the revision its view was built from.
 * The server resolves which card they belong to (asking when several are open),
 * writes through the same field path the card uses, and republishes that same
 * surface. It never creates a second card and never sends.
 */
export const ThreadsEditInteractionInput = ThreadTargetSchema.safeExtend({
  /** Absent when the user used a pronoun; the server resolves or asks. */
  interactionId: Id.optional(),
  /** The revision the model's view was built from. */
  revision: z.number().int().positive(),
  fields: z.record(z.string().trim().min(1).max(64), z.unknown()),
  /** Fields the user typed themselves; a model rewrite must not clobber them. */
  userEditedFields: z.array(z.string().trim().min(1).max(64)).max(40).optional(),
});
export type ThreadsEditInteractionInput = z.infer<typeof ThreadsEditInteractionInput>;

export const ThreadsEditInteractionOutput = z.object({
  ok: z.literal(true),
  interactionId: Id,
  surfaceId: z.string().trim().min(1),
  draftVersion: z.number().int().positive(),
  /** Fields the edit left alone because the user had already typed them. */
  skippedFields: z.array(z.string()).default([]),
  /** True when this edit voided an approval the payload no longer matches. */
  confirmationInvalidated: z.boolean(),
  /** The one short line the turn says; the card holds the fields. */
  nudge: z.string(),
});
export type ThreadsEditInteractionOutput = z.infer<typeof ThreadsEditInteractionOutput>;
