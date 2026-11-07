import type {
  A2uiProtocolFamily,
  EmailSurfaceCapability,
  EmailSurfaceLifecycle,
  EmailSurfaceTemplate,
  InteractionPlan,
  InteractionSurfaceSchema,
} from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
import { compileInteractionSurface } from "./compile-surface.js";
import { basicCatalogId, DEFAULT_PROTOCOL_FAMILY, protocolWireVersion } from "./protocol.js";
import { validateA2uiMessages } from "./validate.js";

export type CompileInteractionPlanInput = {
  plan: InteractionPlan;
  surfaceId: string;
  /** Defaults to v0_9 (Phase 1 render pin). v1_0 is reserved dual-track. */
  protocolFamily?: A2uiProtocolFamily;
  capability?: EmailSurfaceCapability;
  lifecycle?: EmailSurfaceLifecycle;
  template?: EmailSurfaceTemplate;
  providerMessageId?: string;
  error?: string;
  /**
   * The capability's registered schema, when the caller has one. Its labels and
   * field kinds describe the form; without it the plan's own field names are used.
   * Kept as an input rather than read here so this package depends only on
   * contracts.
   */
  schema?: InteractionSurfaceSchema;
};

export type CompileInteractionPlanResult =
  | {
      ok: true;
      protocolFamily: A2uiProtocolFamily;
      surfaceId: string;
      messages: unknown[];
    }
  | {
      ok: false;
      protocolFamily: A2uiProtocolFamily;
      error: string;
    };

type FieldRow = {
  name: string;
  value: unknown;
  required: boolean;
  status: string;
};

/**
 * Compile a Matebot InteractionPlan into a minimal A2UI surface message list.
 * Output is schema-validated against `@a2ui/web_core` for the chosen family.
 */
export async function compileInteractionPlan(
  input: CompileInteractionPlanInput,
): Promise<CompileInteractionPlanResult> {
  const protocolFamily = input.protocolFamily ?? DEFAULT_PROTOCOL_FAMILY;
  const parsedPlan = InteractionPlanSchema.safeParse(input.plan);
  if (!parsedPlan.success) {
    return {
      ok: false,
      protocolFamily,
      error: parsedPlan.error.message,
    };
  }

  const surfaceId = input.surfaceId.trim();
  if (!surfaceId) {
    return { ok: false, protocolFamily, error: "surfaceId is required" };
  }

  const plan = parsedPlan.data;
  const version = protocolWireVersion(protocolFamily);
  const catalogId = basicCatalogId(protocolFamily);
  const fieldRows: FieldRow[] = plan.fields.map((field) => ({
    name: field.name,
    value: field.value ?? null,
    required: field.required,
    status: field.status,
  }));

  const dataModel = {
    title: plan.title,
    summary: plan.summary ?? "",
    intent: plan.intent,
    nextStep: plan.nextStep,
    riskLevel: plan.riskLevel,
    fields: fieldRows,
    // Compiled field controls bind to `/values/<name>`, so the same values the
    // plan already resolved are mirrored here. Without it a form renders empty
    // inputs even though the draft has values.
    values: Object.fromEntries(
      plan.fields
        .filter((field) => field.value !== undefined)
        .map((field) => [field.name, field.value]),
    ),
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(input.template ? { template: input.template } : {}),
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
    ...(input.error ? { error: input.error } : {}),
  };

  // A plan with fields becomes real controls through the validated-schema
  // compiler, so a generic form is not just a title with an empty body.
  const withFields = await compilePlanFieldsAsSurface({
    plan,
    surfaceId,
    protocolFamily,
    ...(input.schema ? { schema: input.schema } : {}),
  });
  const components = buildDraftComponents(protocolFamily, plan, withFields);

  const messages: unknown[] = [
    {
      version,
      createSurface: {
        surfaceId,
        catalogId,
      },
    },
    {
      version,
      updateComponents: {
        surfaceId,
        components,
      },
    },
    {
      version,
      updateDataModel: {
        surfaceId,
        value: dataModel,
      },
    },
  ];

  const validated = await validateA2uiMessages({ messages, protocolFamily });
  if (!validated.ok) {
    return { ok: false, protocolFamily, error: validated.error };
  }

  return {
    ok: true,
    protocolFamily,
    surfaceId,
    messages: validated.messages as unknown[],
  };
}

function buildDraftComponents(
  family: A2uiProtocolFamily,
  plan: InteractionPlan,
  compiled?: unknown[],
): Record<string, unknown>[] {
  // Basic catalog: Text / Column. Keep the tree tiny — hosts refine in later PRs.
  void family;
  /**
   * A plan's fields become real controls through the same compiler a validated
   * schema uses. This used to emit three text nodes and nothing else, so every
   * generic form — a calendar draft, a batch of events — drew a title with an
   * empty body. That empty body is what the audit saw as a blank card.
   */
  if (compiled) return compiled as Record<string, unknown>[];
  void plan;
  return [
    {
      id: "root",
      component: "Column",
      children: ["title", "summary", "fields"],
    },
    {
      id: "title",
      component: "Text",
      text: { path: "/title" },
      variant: "h3",
    },
    {
      id: "summary",
      component: "Text",
      text: { path: "/summary" },
    },
    {
      id: "fields",
      component: "Text",
      text: { path: "/intent" },
    },
  ];
}

/**
 * Compile a plan's fields into real form controls.
 *
 * The plan carries field types only loosely, so each field is compiled as a text
 * control with its label and current value. Returns the component list from the
 * compiled document — not the document itself, which is messages, not components —
 * or undefined when the plan has no fields.
 */
async function compilePlanFieldsAsSurface(input: {
  plan: InteractionPlan;
  surfaceId: string;
  protocolFamily: A2uiProtocolFamily;
  schema?: InteractionSurfaceSchema;
}): Promise<Record<string, unknown>[] | undefined> {
  if (input.plan.fields.length === 0) return undefined;
  /**
   * Render the capability's own schema when there is one, so labels and control
   * kinds come from the registry rather than from the model's field names. A
   * `dateTime` field then gets a date and time input, and a field the model
   * invented for data rather than for editing (a batch list) is not drawn as a
   * text box.
   */
  const declared = input.schema;
  const values = Object.fromEntries(
    input.plan.fields
      .filter((field) => field.value !== undefined)
      .map((field) => [field.name, field.value]),
  );
  const schema = declared
    ? { ...declared, presentation: "form" as const }
    : {
        schemaVersion: 1 as const,
        presentation: "form" as const,
        fields: input.plan.fields.map((field) => ({
          name: field.name,
          label: field.name,
          kind: "text" as const,
          required: field.required,
        })),
        action: { id: "confirm", label: "Confirm", requiresRevision: true },
      };
  const compiled = await compileInteractionSurface({
    schema,
    values,
    surfaceId: input.surfaceId,
    protocolFamily: input.protocolFamily,
  });
  if (!compiled.ok) return undefined;
  const update = (
    compiled.messages as Array<{
      updateComponents?: { components: Record<string, unknown>[] };
    }>
  ).find((message) => message.updateComponents);
  return update?.updateComponents?.components;
}
