import type {
  A2uiProtocolFamily,
  EmailSurfaceCapability,
  EmailSurfaceLifecycle,
  EmailSurfaceTemplate,
  InteractionPlan,
} from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
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
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(input.template ? { template: input.template } : {}),
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
    ...(input.error ? { error: input.error } : {}),
  };

  const components = buildDraftComponents(protocolFamily);

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

function buildDraftComponents(family: A2uiProtocolFamily): Record<string, unknown>[] {
  // Basic catalog: Text / Column. Keep the tree tiny — hosts refine in later PRs.
  void family;
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
