import type { InteractionSurfaceSchema } from "@matebot/contracts";
import type { OpenSurface, SurfaceStatus } from "@matebot/core";
import { canSubmitSurface, resolveSurfaceTarget } from "@matebot/core";

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
  } | null>;
  /** Every live card in the thread, so an unnamed reference can be judged. */
  listOpenSurfaces: (input: { spaceId: string; threadId: string }) => Promise<OpenSurface[]>;
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

function statusOf(row: {
  status: string;
  confirmedVersion: number | null;
  draftVersion: number;
}): SurfaceStatus {
  if (row.status === "succeeded") return "executed";
  if (row.confirmedVersion !== null && row.confirmedVersion === row.draftVersion) return "approved";
  return "draft";
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

  const status = statusOf(row);
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

  const userEdited = new Set(input.userEditedFields ?? []);
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
