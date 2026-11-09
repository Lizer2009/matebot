import type {
  A2uiProtocolFamily,
  EmailSurfaceCapability,
  EmailSurfaceLifecycle,
  EmailSurfaceTemplate,
  InteractionField,
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
      /**
       * Declared required fields still without a value. The card is published and editable;
       * the caller holds the confirm action back until this is empty.
       */
      missingRequired: string[];
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
  // Reconcile the plan's field names onto the registered schema before anything reads them.
  // Both the control binding and the data model must use one spelling: the email editor looks
  // its values up by exact name (`emailFieldsFromSurfaceMessages`), so a plan that said `To`
  // while the schema says `to` would render an empty field no matter what the controls held.
  const reconciled = input.schema ? canonicalPlanFields(plan.fields, input.schema) : undefined;
  if (reconciled?.conflict) {
    return {
      ok: false,
      protocolFamily,
      error: `conflicting values for field "${reconciled.conflict}"; edit the card instead of replacing it`,
    };
  }
  const effectiveFields = reconciled ? reconciled.fields : plan.fields;
  const fieldRows: FieldRow[] = effectiveFields.map((field) => ({
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
      effectiveFields
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
    fields: effectiveFields,
    ...(reconciled ? { extra: reconciled.extra } : {}),
  });
  // A registered form that fails to compile is an error the caller must see. The caption
  // fallback below stays for plans that carry no fields at all, which is a different thing:
  // there is nothing to type into by design.
  if (withFields && "error" in withFields) {
    return { ok: false, protocolFamily, error: withFields.error };
  }
  const components = buildDraftComponents(protocolFamily, plan, withFields?.components);
  const missingRequired = withFields?.missingRequired ?? [];
  // The data model must describe the same fields the controls bind to, or the form shows one
  // set of names and stores another.
  const modelValues = withFields?.values ?? dataModel.values;

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
        value: { ...dataModel, values: modelValues },
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
    missingRequired,
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
 * control with its label and current value. Returns the compiled result — the component list
 * plus the declared required fields that are still empty — or undefined when the plan has no
 * fields at all.
 */
async function compilePlanFieldsAsSurface(input: {
  plan: InteractionPlan;
  surfaceId: string;
  protocolFamily: A2uiProtocolFamily;
  schema?: InteractionSurfaceSchema;
  /** Fields already reconciled onto the schema's names by the caller. */
  fields?: readonly InteractionField[];
  /** Fields the plan carries beyond the schema: data for the action, never controls. */
  extra?: readonly InteractionField[];
}): Promise<
  | {
      components: Record<string, unknown>[];
      missingRequired: string[];
      values: Record<string, unknown>;
    }
  | { error: string }
  | undefined
> {
  const declared = input.schema;
  const reconciled = input.fields ?? input.plan.fields;
  // A registered form always draws its declared fields, even when the plan listed none: that is
  // the difference between "the model left the fields out" and "this surface has no fields".
  if (reconciled.length === 0 && !declared) return undefined;
  /**
   * Render the capability's own schema when there is one, so labels and control
   * kinds come from the registry rather than from the model's field names. A
   * `dateTime` field then gets a date and time input, and a field the model
   * invented for data rather than for editing (a batch list) is not drawn as a
   * text box.
   */
  const extra = input.extra ?? [];
  const plannedFields = [...reconciled, ...extra];
  // Fields the plan carries beyond the schema are data, not controls: a calendar batch list,
  // for instance, is read by the execute path but must not become a text box. They stay in the
  // values passed to the compiler, which only reads the schema's own field names.
  const values = Object.fromEntries(
    plannedFields
      .filter((field) => field.value !== undefined)
      .map((field) => [field.name, field.value]),
  );
  const schema = declared
    ? { ...declared, presentation: "form" as const }
    : {
        schemaVersion: 1 as const,
        presentation: "form" as const,
        fields: plannedFields.map((field) => ({
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
  // A real compile failure is reported, never downgraded to a caption. The earlier behaviour
  // returned undefined here, which the caller turned into three Text nodes: a published card
  // with nothing in it and no error anywhere.
  if (!compiled.ok) return { error: compiled.error };
  const update = (
    compiled.messages as Array<{
      updateComponents?: { components: Record<string, unknown>[] };
    }>
  ).find((message) => message.updateComponents);
  const components = update?.updateComponents?.components;
  if (!components || components.length === 0) {
    return { error: "the surface compiled to no components" };
  }
  return { components, missingRequired: compiled.missingRequired, values };
}

/** A field's value counts as absent when it is nullish or blank, matching the confirm gate. */
function isEmptyFieldValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/**
 * Map a plan's field names onto the registered schema's names.
 *
 * The compiler used to key controls and values on whatever the plan called each field, so a
 * plan that named the same three values `To`/`Subject`/`Body` on one hand and `to`/`subject`/
 * `body` on the other produced a value map nothing matched and a form that could not validate.
 * Names are matched case-insensitively against the schema, and the schema's spelling wins, so
 * both key sets collapse onto one field.
 *
 * Two fields that resolve to the same schema field with *different* values are a conflict, not
 * a merge: silently keeping one would discard a value the user may have edited. `conflict`
 * names the field so the caller can refuse and point at `edit_interaction` instead.
 *
 * A field the schema does not declare is returned in `extra` rather than dropped. It is data
 * for the action (a calendar batch list), not a control.
 */
export function canonicalPlanFields(
  fields: readonly InteractionField[],
  schema: InteractionSurfaceSchema,
): { fields: InteractionField[]; extra: InteractionField[]; conflict?: string } {
  const declaredNames = new Map(
    schema.fields.map((field) => [field.name.toLowerCase(), field.name]),
  );
  const byCanonical = new Map<string, InteractionField>();
  const extraByName = new Map<string, InteractionField>();
  for (const field of fields) {
    const canonical = declaredNames.get(field.name.trim().toLowerCase());
    if (!canonical) {
      // An undeclared name is data, but two entries under the same name are still one value:
      // keeping the last would drop the first with no error, which is the silent loss the
      // conflict rule exists to prevent.
      const previous = extraByName.get(field.name);
      if (previous && previous.value !== field.value) {
        return { fields: [...fields], extra: [], conflict: field.name };
      }
      extraByName.set(field.name, field);
      continue;
    }
    const existing = byCanonical.get(canonical);
    if (!existing) {
      byCanonical.set(canonical, { ...field, name: canonical });
      continue;
    }
    // The normalisers insert a schema-named field with no value ahead of whatever the model
    // sent, so "empty placeholder, then the real value" is the common shape. A value beats an
    // empty slot; only two different values are a genuine conflict, because choosing one would
    // discard the other.
    const existingEmpty = isEmptyFieldValue(existing.value);
    const incomingEmpty = isEmptyFieldValue(field.value);
    if (existingEmpty && !incomingEmpty) {
      byCanonical.set(canonical, { ...field, name: canonical });
      continue;
    }
    if (incomingEmpty || existing.value === field.value) continue;
    return { fields: [...fields], extra: [], conflict: canonical };
  }
  // Schema order keeps the card's field order stable no matter how the plan listed them.
  const ordered = schema.fields
    .map((field) => byCanonical.get(field.name))
    .filter((field): field is InteractionField => field !== undefined);
  return { fields: ordered, extra: [...extraByName.values()] };
}
