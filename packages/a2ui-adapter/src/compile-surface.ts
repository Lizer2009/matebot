import type {
  A2uiProtocolFamily,
  InteractionFieldSpec,
  InteractionSurfaceSchema,
} from "@matebot/contracts";
import { InteractionSurfaceSchema as InteractionSurfaceSchemaZ } from "@matebot/contracts";
import { basicCatalogId, DEFAULT_PROTOCOL_FAMILY, protocolWireVersion } from "./protocol.js";
import { validateA2uiMessages } from "./validate.js";

/**
 * The trusted compiler: a validated field schema plus current values become an
 * A2UI component tree built only from the basic catalog. The model chooses a
 * registered schema and supplies values; it never authors components, and no
 * node here comes from its text.
 */

/** Action names are prefixed so one bridge can tell them from anything else. */
export const INTERACTION_ACTION_EVENT = "interaction.action" as const;

/**
 * Actions a surface may dispatch. A capability picks one of these; the list is
 * closed so an unknown button can never reach the server. Adding a capability
 * action means adding it here *and* in the dispatch bridge, which the runtime
 * tests pin.
 */
export const INTERACTION_ALLOWED_ACTIONS = ["send", "create", "save", "confirm"] as const;
export type InteractionAllowedAction = (typeof INTERACTION_ALLOWED_ACTIONS)[number];

const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(INTERACTION_ALLOWED_ACTIONS);

/** Component ids are namespaced so a field named "root" cannot collide. */
const idFor = (field: InteractionFieldSpec) => `field_${field.name}`;
const labelIdFor = (field: InteractionFieldSpec) => `label_${field.name}`;
const ACTION_LABEL_ID = "action_label";
const ACTION_ID = "action";
const TITLE_ID = "title";
const SUMMARY_ID = "summary";
const RESULT_IDS = (index: number) => `result_${index}`;

export type CompileInteractionSurfaceInput = {
  schema: InteractionSurfaceSchema;
  /** Current server-side values. Never taken from the client for compilation. */
  values: Record<string, unknown>;
  surfaceId: string;
  interactionId?: string;
  /** Optimistic concurrency stamp shown to the host so it can reject stale submits. */
  revision?: number;
  protocolFamily?: A2uiProtocolFamily;
  /** For `result` surfaces: title plus pre-formatted lines or table rows. */
  result?: { title?: string; rows: Array<string | Record<string, unknown>> };
  title?: string;
  summary?: string;
};

export type CompileInteractionSurfaceResult =
  | {
      ok: true;
      protocolFamily: A2uiProtocolFamily;
      surfaceId: string;
      messages: unknown[];
      dataModel: SurfaceDataModel;
    }
  | { ok: false; protocolFamily: A2uiProtocolFamily; error: string };

export type SurfaceDataModel = {
  values: Record<string, unknown>;
  revision: number;
  interactionId?: string;
  action?: { id: string; event: string };
  rows?: Array<string | Record<string, unknown>>;
};

/**
 * The data model the surface binds to. Revision lives here so every control
 * shares one source of truth for "which draft is on screen".
 */
export function surfaceDataModel(input: {
  schema: InteractionSurfaceSchema;
  values: Record<string, unknown>;
  surfaceId: string;
  revision?: number;
  interactionId?: string;
  rows?: Array<string | Record<string, unknown>>;
}): SurfaceDataModel {
  return {
    values: { ...input.values },
    revision: input.revision ?? 1,
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    ...(input.schema.action
      ? {
          action: {
            id: input.schema.action.id,
            event: `${INTERACTION_ACTION_EVENT}.${input.schema.action.id}`,
          },
        }
      : {}),
    ...(input.rows ? { rows: input.rows } : {}),
  };
}

type Component = Record<string, unknown>;

function coerceValue(field: InteractionFieldSpec, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  switch (field.kind) {
    case "number":
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "string" && raw.trim() !== "") {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    default:
      return typeof raw === "string" ? raw : undefined;
  }
}

/** Validate values against the schema; compilation must not trust the client. */
function checkValues(
  schema: InteractionSurfaceSchema,
  values: Record<string, unknown>,
): string | undefined {
  for (const field of schema.fields) {
    const value = coerceValue(field, values[field.name]);
    if (value === undefined) {
      if (field.required) return `Missing required value: ${field.name}`;
      continue;
    }
    if (field.kind === "choice") {
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (typeof value !== "string" || !allowed.has(value)) {
        return `Value for ${field.name} is not one of its options`;
      }
    }
    if (typeof value === "string" && field.maxLength && value.length > field.maxLength) {
      return `Value for ${field.name} exceeds ${field.maxLength} characters`;
    }
  }
  return undefined;
}

/** One control per field, mapped from the closed kind list. */
function fieldComponent(field: InteractionFieldSpec): Component {
  const path = { path: `/values/${field.name}` };
  const base: Component = {
    id: idFor(field),
    label: field.label,
    ...(field.help ? { accessibility: { description: field.help } } : {}),
  };
  switch (field.kind) {
    case "longText":
      return { ...base, component: "TextField", value: path, variant: "longText" };
    case "number":
      return { ...base, component: "TextField", value: path, variant: "number" };
    case "email":
      return { ...base, component: "TextField", value: path, variant: "shortText" };
    case "dateTime":
      return {
        ...base,
        component: "DateTimeInput",
        value: path,
        enableDate: true,
        enableTime: true,
      };
    case "boolean":
      return { ...base, component: "CheckBox", value: path };
    case "choice":
      return {
        ...base,
        component: "ChoicePicker",
        value: path,
        options: (field.options ?? []).map((option) => ({
          value: option.value,
          label: option.label,
        })),
      };
    default:
      return { ...base, component: "TextField", value: path, variant: "shortText" };
  }
}

function buildFormComponents(input: {
  schema: InteractionSurfaceSchema;
  values: Record<string, unknown>;
  title?: string;
  summary?: string;
}): Component[] {
  const { schema } = input;
  const children: string[] = [];
  const components: Component[] = [];

  if (input.title) {
    children.push(TITLE_ID);
    components.push({ id: TITLE_ID, component: "Text", text: input.title, variant: "h3" });
  }
  if (input.summary) {
    children.push(SUMMARY_ID);
    components.push({ id: SUMMARY_ID, component: "Text", text: input.summary });
  }

  for (const field of schema.fields) {
    // A visible label keeps the control named even on hosts that drop `label`.
    children.push(labelIdFor(field));
    components.push({
      id: labelIdFor(field),
      component: "Text",
      text: field.label,
    });
    children.push(idFor(field));
    components.push(fieldComponent(field));
  }

  if (schema.action) {
    children.push(ACTION_ID);
    components.push({
      id: ACTION_LABEL_ID,
      component: "Text",
      text: schema.action.label,
    });
    components.push({
      id: ACTION_ID,
      component: "Button",
      child: ACTION_LABEL_ID,
      variant: "primary",
      action: {
        event: {
          name: `${INTERACTION_ACTION_EVENT}.${schema.action.id}`,
          // Bound to the data model, so the click carries the exact interaction
          // and revision this surface was rendered from. Literal values would
          // let a stale card submit against a newer draft.
          context: {
            interactionId: { path: "/interactionId" },
            revision: { path: "/revision" },
          },
        },
      },
    });
  }

  return [{ id: "root", component: "Column", children }, ...components];
}

/** A result surface lists data and offers no control. */
function buildResultComponents(input: {
  title?: string;
  rows: Array<string | Record<string, unknown>>;
}): Component[] {
  const children: string[] = [];
  const components: Component[] = [];

  if (input.title) {
    children.push(TITLE_ID);
    components.push({ id: TITLE_ID, component: "Text", text: input.title, variant: "h3" });
  }

  input.rows.forEach((row, index) => {
    const id = RESULT_IDS(index);
    children.push(id);
    if (typeof row === "string") {
      components.push({ id, component: "Text", text: row });
      return;
    }
    // A record becomes one line of `label: value` pairs, which is a Row of Texts.
    const cells = Object.entries(row).map(([key, value], cellIndex) => {
      const cellId = `${id}_c${cellIndex}`;
      components.push({ id: cellId, component: "Text", text: `${key}: ${String(value)}` });
      return cellId;
    });
    components.push({ id, component: "Row", children: cells });
  });

  return [{ id: "root", component: "Column", children }, ...components];
}

/**
 * Compile a validated surface schema into A2UI messages.
 * Every failure is returned, never thrown, so callers can fall back safely.
 */
export async function compileInteractionSurface(
  input: CompileInteractionSurfaceInput,
): Promise<CompileInteractionSurfaceResult> {
  const protocolFamily = input.protocolFamily ?? DEFAULT_PROTOCOL_FAMILY;
  const fail = (error: string): CompileInteractionSurfaceResult => ({
    ok: false,
    protocolFamily,
    error,
  });

  const parsed = InteractionSurfaceSchemaZ.safeParse(input.schema);
  if (!parsed.success) return fail(parsed.error.message);
  const schema = parsed.data;

  const surfaceId = input.surfaceId.trim();
  if (!surfaceId) return fail("surfaceId is required");

  if (schema.presentation === "form") {
    if (!schema.action) return fail("A form surface requires one action");
    if (!ALLOWED_ACTIONS.has(schema.action.id)) {
      return fail(`Action "${schema.action.id}" is not allowlisted`);
    }
  }
  if (schema.presentation !== "form" && schema.action) {
    return fail(`A ${schema.presentation} surface must not declare an action`);
  }

  const valueError = checkValues(schema, input.values);
  if (valueError) return fail(valueError);

  const version = protocolWireVersion(protocolFamily);
  const catalogId = basicCatalogId(protocolFamily);
  const components =
    schema.presentation === "form"
      ? buildFormComponents({ ...input, schema })
      : buildResultComponents({
          title: input.result?.title ?? input.title,
          rows: input.result?.rows ?? [],
        });

  const dataModel = surfaceDataModel({
    schema,
    values: input.values,
    surfaceId,
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    ...(input.result?.rows ? { rows: input.result.rows } : {}),
  });

  const messages: unknown[] = [
    { version, createSurface: { surfaceId, catalogId } },
    { version, updateComponents: { surfaceId, components } },
    { version, updateDataModel: { surfaceId, value: dataModel } },
  ];

  const validated = await validateA2uiMessages({ messages, protocolFamily });
  if (!validated.ok) return fail(validated.error);

  return {
    ok: true,
    protocolFamily,
    surfaceId,
    messages: validated.messages as unknown[],
    dataModel,
  };
}
