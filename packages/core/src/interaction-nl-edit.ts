import type { InteractionPlan, InteractionSurfaceSchema } from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
import { withFieldValue } from "./interaction-runtime.js";
import { surfaceStatusFor } from "./interaction-status.js";
import { canSubmitSurface } from "./surface-revision.js";
import type { OpenSurface } from "./surface-target.js";
import { resolveSurfaceTarget } from "./surface-target.js";

/**
 * Applies a model-proposed natural-language edit to an existing draft.
 *
 * The model supplies field values only. This service decides which card they
 * belong to, checks the revision the model saw, writes through the same field
 * route the card uses, and republishes the same surface. It never creates a
 * second card and never sends: a prose edit is an edit.
 */

export type NaturalLanguageEditDeps = {
  loadInteraction: (interactionId: string) => Promise<{
    id: string;
    spaceId: string;
    threadId: string;
    intent: string;
    status: string;
    draftVersion: number;
    confirmedVersion: number | null;
    slots: Record<string, unknown>;
    /**
     * Field names the person typed, read from the persisted draft. A model edit
     * must leave them alone even when the caller did not pass the list itself.
     */
    userEditedFields?: readonly string[];
    /** The stored plan, needed to build a correction of a record that already ran. */
    plan?: unknown;
  } | null>;
  /**
   * Cards in the thread. Live ones by default; `includeExecuted` also returns
   * finished ones so a caller can explain that a card already ran.
   */
  listOpenSurfaces: (input: {
    spaceId: string;
    threadId: string;
    includeExecuted?: boolean;
  }) => Promise<OpenSurface[]>;
  /**
   * The same write the card's direct edit uses. It already recompiles and
   * republishes the surface, which is why prose edits and direct edits cannot
   * diverge: there is one write path, not two.
   */
  applyField: (input: {
    spaceId: string;
    threadId: string;
    botId: string;
    interactionId: string;
    expectedDraftVersion: number;
    name: string;
    value: unknown;
  }) => Promise<{ draftVersion: number }>;
};

export type NaturalLanguageEditInput = {
  spaceId: string;
  threadId: string;
  botId?: string;
  /** Absent when the user used a pronoun; resolution then decides. */
  interactionId?: string;
  schema: InteractionSurfaceSchema;
  fields: Record<string, unknown>;
  /** The revision the model's view was built from. */
  revision: number;
  /** Fields the user typed; a model rewrite must not clobber them. */
  userEditedFields?: readonly string[];
};

export type NaturalLanguageEditResult =
  | {
      ok: true;
      interactionId: string;
      surfaceId: string;
      draftVersion: number;
      values: Record<string, unknown>;
      skippedFields: string[];
      /** True when this edit voided a payload the user had already approved. */
      confirmationInvalidated: boolean;
      /** The one line the turn should say. */
      nudge: string;
    }
  | { ok: false; error: string };

/**
 * Fields the person typed, read from the persisted draft.
 *
 * The card's own control stamps `source: "user"` on the field it writes, so the
 * protected set survives a restart and does not depend on the caller remembering
 * to send it. A model edit skips these; nothing else can silently overwrite what
 * someone actually typed (spec §6.4.3).
 */
export function userEditedFieldNames(plan: unknown): string[] {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return [];
  const fields = (plan as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter(
      (field): field is { name: string } =>
        Boolean(field) &&
        typeof field === "object" &&
        typeof (field as { name?: unknown }).name === "string" &&
        (field as { source?: unknown }).source === "user",
    )
    .map((field) => field.name);
}

export async function applyNaturalLanguageEdit(
  deps: NaturalLanguageEditDeps,
  input: NaturalLanguageEditInput,
): Promise<NaturalLanguageEditResult> {
  // Which card? An unnamed reference with several open cards must be clarified.
  const open = await deps.listOpenSurfaces({ spaceId: input.spaceId, threadId: input.threadId });
  const target = resolveSurfaceTarget({
    surfaces: open,
    reference: input.interactionId ? { taskId: input.interactionId } : { pronoun: true },
  });
  if (target.kind === "clarify") return { ok: false, error: "ambiguous_target" };
  if (target.kind === "none") return { ok: false, error: "no_open_surface" };
  if (target.kind === "not_found") return { ok: false, error: "unknown_interaction" };

  const row = await deps.loadInteraction(target.taskId);
  if (!row) return { ok: false, error: "unknown_interaction" };
  // Republish the surface the card is already showing, not the task id.
  const openSurface = open.find((surface) => surface.taskId === row.id);
  if (!openSurface) return { ok: false, error: "unknown_surface" };
  if (row.spaceId !== input.spaceId || row.threadId !== input.threadId) {
    return { ok: false, error: "forbidden" };
  }

  const status = surfaceStatusFor(row.status);
  if (status === "executed") {
    // Corrections are a new linked draft, not an in-place edit of the record.
    return { ok: false, error: "already_executed" };
  }

  // The model may only touch fields the schema declares; that also keeps a
  // secret or an endpoint from arriving through a generated form.
  const declared = new Set(input.schema.fields.map((field) => field.name));
  for (const name of Object.keys(input.fields)) {
    if (!declared.has(name)) return { ok: false, error: "unknown_field" };
  }

  // A stale view means the model edited a draft the user has since changed.
  const gate = canSubmitSurface({
    state: {
      taskId: row.id,
      surfaceId: openSurface.surfaceId,
      revision: row.draftVersion,
      status: "approved",
      values: {},
      editedFields: [],
    },
    submittedRevision: input.revision,
  });
  if (!gate.ok && gate.error === "stale_revision") {
    return { ok: false, error: "stale_revision" };
  }

  const userEdited = new Set([...(input.userEditedFields ?? []), ...(row.userEditedFields ?? [])]);
  const fields: Record<string, unknown> = {};
  const skippedFields: string[] = [];
  for (const [name, value] of Object.entries(input.fields)) {
    if (userEdited.has(name)) {
      skippedFields.push(name);
      continue;
    }
    if (row.slots[name] === value) continue;
    fields[name] = value;
  }

  if (Object.keys(fields).length === 0) {
    // Nothing to write: report the current revision so the caller does not
    // republish a card that did not change.
    return {
      ok: true,
      interactionId: row.id,
      surfaceId: openSurface.surfaceId,
      draftVersion: row.draftVersion,
      values: row.slots,
      skippedFields,
      confirmationInvalidated: false,
      nudge: "卡片没有需要改动的内容。",
    };
  }

  // Each field goes through the same service the card calls. The service bumps
  // the revision and republishes the surface, so one surface stays on screen.
  let draftVersion = row.draftVersion;
  const values: Record<string, unknown> = { ...row.slots };
  for (const [name, value] of Object.entries(fields)) {
    const applied = await deps.applyField({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId ?? "",
      interactionId: row.id,
      expectedDraftVersion: draftVersion,
      name,
      value,
    });
    draftVersion = applied.draftVersion;
    values[name] = value;
  }

  return {
    ok: true,
    interactionId: row.id,
    surfaceId: openSurface.surfaceId,
    draftVersion,
    values,
    skippedFields,
    // Changing an approved payload means the old approval no longer describes it.
    confirmationInvalidated: status === "approved",
    nudge: "已更新卡片，请在卡片上确认。",
  };
}

export type AmendmentResult =
  | { ok: true; plan: InteractionPlan; changedFields: string[]; skippedFields: string[] }
  | { ok: false; error: "unknown_field" | "no_change" | "invalid_plan" };

/**
 * Build the draft that corrects a record that already ran.
 *
 * The executed row is a record of what happened, so a correction cannot be an
 * edit of it: it is a new draft carrying the amended values and pointing at the
 * original. Running it then needs its own confirmation and its own effect, which
 * is why this returns a plan rather than publishing or executing anything.
 *
 * Fields the person typed on the new draft are still protected, using the same
 * rule as an ordinary edit.
 */
export function buildAmendment(input: {
  plan: unknown;
  fields: Record<string, unknown>;
  schema: InteractionSurfaceSchema;
  userEditedFields?: readonly string[];
}): AmendmentResult {
  const parsed = InteractionPlanSchema.safeParse(input.plan);
  if (!parsed.success) return { ok: false, error: "invalid_plan" };

  const declared = new Set(input.schema.fields.map((field) => field.name));
  for (const name of Object.keys(input.fields)) {
    if (!declared.has(name)) return { ok: false, error: "unknown_field" };
  }

  const userEdited = new Set(input.userEditedFields ?? []);
  const changedFields: string[] = [];
  const skippedFields: string[] = [];
  const fields = parsed.data.fields.map((field) => {
    if (!(field.name in input.fields)) return field;
    if (userEdited.has(field.name)) {
      skippedFields.push(field.name);
      return field;
    }
    const value = input.fields[field.name];
    if (field.value === value) return field;
    changedFields.push(field.name);
    return { ...withFieldValue(field, value), source: "model" };
  });

  if (changedFields.length === 0) return { ok: false, error: "no_change" };

  return {
    ok: true,
    plan: { ...parsed.data, fields },
    changedFields,
    skippedFields,
  };
}
