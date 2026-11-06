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

export const InteractionFieldSchema = z.object({
  name: z.string().trim().min(1),
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
  /** Short label for the timeline before/without the full catalog document. */
  title: z.string().optional(),
  summary: z.string().optional(),
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
