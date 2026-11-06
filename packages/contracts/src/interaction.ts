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
  /** Short label for the timeline before/without the full catalog document. */
  title: z.string().optional(),
  summary: z.string().optional(),
  /**
   * Server-held document or patch pointer for later hydrate; not a client authority.
   * Opaque string so Event/Message embedding (PR-4) can choose its own key shape.
   */
  documentRef: z.string().trim().min(1).optional(),
});
export type A2uiSurfaceBlock = z.infer<typeof A2uiSurfaceBlockSchema>;

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
});
export type InteractionProductEventPayload = z.infer<typeof InteractionProductEventPayloadSchema>;

/** Suggested payload for thread.surface.* ProductEvents. */
export const SurfaceProductEventPayloadSchema = z.object({
  interactionId: Id,
  surfaceId: z.string().trim().min(1),
  protocolFamily: A2uiProtocolFamily,
  draftVersion: z.number().int().positive(),
  title: z.string().optional(),
  summary: z.string().optional(),
  documentRef: z.string().trim().min(1).optional(),
  messageId: Id.optional(),
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
});
export type ThreadsConfirmInteractionOutput = z.infer<typeof ThreadsConfirmInteractionOutput>;
