import * as z from "zod";

/**
 * Field kinds the trusted compiler knows how to turn into a basic-catalog
 * control. Kept deliberately small and closed: a plan may only name a kind on
 * this list, and the compiler maps each one to a real component. Nothing here
 * is model-authored UI — the model picks a kind, the server owns the widget.
 */
export const InteractionFieldKind = z.enum([
  "text",
  "longText",
  "number",
  "email",
  "dateTime",
  "boolean",
  "choice",
]);
export type InteractionFieldKind = z.infer<typeof InteractionFieldKind>;

/** One option of a `choice` field. Value is what the server stores and validates. */
export const InteractionFieldOption = z.object({
  value: z.string().trim().min(1),
  label: z.string().trim().min(1),
});
export type InteractionFieldOption = z.infer<typeof InteractionFieldOption>;

/**
 * A field the compiler can render and the server can validate. This is the
 * schema a capability registers, not something the model invents per prompt:
 * `present_interaction` may only reference kinds and options declared here.
 */
export const InteractionFieldSpec = z
  .object({
    name: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(120),
    kind: InteractionFieldKind,
    required: z.boolean().default(false),
    placeholder: z.string().trim().max(200).optional(),
    help: z.string().trim().max(200).optional(),
    /** Only for `choice`; ignored elsewhere. */
    options: z.array(InteractionFieldOption).max(50).optional(),
    /** Only for `text`/`email`/`longText`: server-side length cap. */
    maxLength: z.number().int().positive().max(20_000).optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.kind === "choice" && (!spec.options || spec.options.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "A choice field needs at least one option",
      });
    }
    if (spec.kind !== "choice" && spec.options) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "Only a choice field may declare options",
      });
    }
    if (spec.options) {
      const seen = new Set<string>();
      for (const option of spec.options) {
        if (seen.has(option.value)) {
          ctx.addIssue({
            code: "custom",
            path: ["options"],
            message: `Duplicate option value: ${option.value}`,
          });
          break;
        }
        seen.add(option.value);
      }
    }
  });
export type InteractionFieldSpec = z.infer<typeof InteractionFieldSpec>;

/** What the compiler emits for a field group: a form, a read-only summary, or nothing. */
export const InteractionPresentation = z.enum(["form", "result", "progress"]);
export type InteractionPresentation = z.infer<typeof InteractionPresentation>;

/**
 * The single action a form may offer. `id` is checked against the server's
 * action allowlist; nothing else in the plan can produce a clickable control.
 */
export const InteractionActionSpec = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(60),
  /** Sent to the client so a stale surface cannot submit after a newer revision. */
  requiresRevision: z.boolean().default(true),
});
export type InteractionActionSpec = z.infer<typeof InteractionActionSpec>;

/**
 * Server-owned schema for a surface. A capability declares this once; every
 * turn of that task reuses it, so a new prompt does not need a new template.
 */
export const InteractionSurfaceSchema = z.object({
  schemaVersion: z.number().int().positive(),
  presentation: InteractionPresentation,
  fields: z.array(InteractionFieldSpec).max(40),
  /**
   * The one primary action, or null for a result/progress surface. Never more
   * than one: a second competing button is what the spec forbids.
   */
  action: InteractionActionSpec.nullable(),
});
export type InteractionSurfaceSchema = z.infer<typeof InteractionSurfaceSchema>;

/**
 * Where a result's numbers came from. Required on every result surface: a figure
 * with no traceable origin is what the spec forbids showing at all.
 */
export const ResultProvenanceSchema = z.object({
  /** Who produced the numbers: a file the user supplied, a connector, a query. */
  source: z.string().trim().min(1).max(200),
  /** When the data was measured, not when the card was drawn. */
  asOf: z.string().trim().min(1),
  window: z.object({ from: z.string().trim().min(1), to: z.string().trim().min(1) }).optional(),
  /** The unit of any measure, e.g. "CNY" or "count". Never invented. */
  units: z.string().trim().max(32).optional(),
  timezone: z.string().trim().max(64).optional(),
  /** The calendar year the measure belongs to. */
  year: z.number().int().min(1900).max(2999).optional(),
  /** When the source itself was last updated; distinct from asOf. */
  freshness: z.string().trim().min(1).optional(),
});
export type ResultProvenance = z.infer<typeof ResultProvenanceSchema>;

export const ResultColumnSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  align: z.enum(["start", "end"]).optional(),
});
export type ResultColumn = z.infer<typeof ResultColumnSchema>;

/** A cell is a scalar; structure never reaches the surface. */
export const ResultCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** A bounded result: rows already truncated and flagged by the server. */
export const ResultSurfaceSchema = z.object({
  title: z.string(),
  provenance: ResultProvenanceSchema,
  columns: z.array(ResultColumnSchema),
  rows: z.array(z.record(z.string(), ResultCellSchema)),
  truncated: z.boolean(),
  totalRows: z.number().int().nonnegative(),
  empty: z.boolean(),
  emptyNotice: z.string().optional(),
});
export type ResultSurface = z.infer<typeof ResultSurfaceSchema>;

/**
 * Spec §6.3 — the model's structured decision about a request, before any
 * surface exists. A proposal only: the server still owns whether the named
 * capability exists and may render.
 */
export const InteractionPresentationChoice = z.enum([
  "text",
  "result",
  "form",
  "review",
  "progress",
]);
export type InteractionPresentationChoice = z.infer<typeof InteractionPresentationChoice>;

export const InteractionDecisionSchema = z.object({
  /** Stable task identity: decides same-card update versus a new card. */
  taskIdentity: z.string().trim().min(1).max(200),
  /** What the model thinks could answer the request, best first. */
  capabilityCandidates: z.array(z.string().trim().min(1).max(120)).min(1).max(5),
  /** Fields that block execution; drives a minimal clarification. */
  missingFields: z.array(z.string().trim().min(1).max(64)).max(40).default([]),
  permissions: z
    .object({
      sourceAvailable: z.boolean().optional(),
      connectionReady: z.boolean().optional(),
    })
    .optional(),
  presentationChoice: InteractionPresentationChoice,
  presentationReason: z.string().trim().max(200).optional(),
  /** Decision/schema version, so a proposal can be replayed. */
  version: z.number().int().positive().default(1),
});
export type InteractionDecision = z.infer<typeof InteractionDecisionSchema>;
