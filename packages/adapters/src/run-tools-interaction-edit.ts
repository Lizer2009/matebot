import type { InteractionPlan, InteractionSurfaceSchema } from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
import type {
  EmailSurfaceCapability,
  InteractionCapability,
  NaturalLanguageEditDeps,
} from "@matebot/core";
import {
  applyNaturalLanguageEdit,
  buildAmendment,
  EDITABLE_STATUSES,
  interactionCapabilityForIntent,
  surfaceStatusFor,
  userEditedFieldNames,
} from "@matebot/core";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import { updateInteractionFieldService } from "./interaction-field-writer.js";
import { InteractionCardOccupiedError, publishOrAmend } from "./interaction-publish.js";
import type { DraftSender } from "./interaction-readback.js";
import { readbackFromStored } from "./interaction-readback.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { interactionPublishCapability } from "./run-tools-interaction.js";

/**
 * `edit_interaction`: the model changing a card that is already in the chat.
 *
 * This is the tool the agent loop actually calls when the user follows up with
 * "change the subject" or "make it Tuesday". It resolves the card, refuses a
 * stale revision, writes through the same field service the card's own controls
 * use, and republishes that one surface. It deliberately cannot send: the card's
 * Send is still the only path to an effect, and it needs the user's own click.
 *
 * The orchestration lives in `@matebot/core` so the HTTP route and this tool run
 * the same code rather than two implementations that can drift.
 */

/**
 * What a successful edit reports.
 *
 * The readback is optional because a caller without the plumbing to read the stored row gets the
 * edit alone rather than a failed edit — but it is part of the result's shape, so a caller that
 * reads it is not reading an undeclared property.
 */
type EditReadback =
  | {
      fields?: Array<{ name: string; value: string; required: boolean; filled: boolean }>;
      missingRequired?: string[];
      actionable?: boolean;
      blockedBy?: string[];
      sender?: { label: string; address?: string };
    }
  | Record<string, never>;

export type EditInteractionResult =
  | ({
      ok: true;
      interactionId: string;
      surfaceId: string;
      draftVersion: number;
      skippedFields: string[];
      confirmationInvalidated: boolean;
      /** The only words the turn should add. */
      reply: string;
    } & EditReadback)
  | ({
      ok: true;
      /** True when this created a linked draft instead of editing in place. */
      amendment: true;
      interactionId: string;
      surfaceId: string;
      draftVersion: number;
      skippedFields: string[];
      confirmationInvalidated: true;
      reply: string;
    } & EditReadback)
  | {
      ok: false;
      error: string;
      /** Present for `ambiguous_target`: the cards the user must choose between. */
      candidates?: Array<{ interactionId: string; label: string }>;
      reply?: string;
    };

function fallbackSchema(): InteractionSurfaceSchema {
  return { schemaVersion: 1, presentation: "result", fields: [], action: null };
}

function capabilityForIntent(intent: string | undefined): InteractionCapability | undefined {
  return intent ? interactionCapabilityForIntent(intent) : undefined;
}

/**
 * Read the arguments the model sent. The tool schema requires `fields` and
 * `revision`; anything else is rejected rather than coerced, because a guessed
 * revision would edit the wrong draft.
 */
function parseArgs(args: Record<string, unknown>):
  | {
      ok: true;
      fields: Record<string, unknown>;
      revision: number;
      interactionId?: string;
    }
  | { ok: false; error: string } {
  const fields = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return { ok: false, error: "fields must be an object of field name to new value" };
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, error: "fields must not be empty" };
  const revision = args.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, error: "revision must be the positive integer shown on the card" };
  }
  const interactionId =
    typeof args.interactionId === "string" && args.interactionId.trim()
      ? args.interactionId.trim()
      : undefined;
  return { ok: true, fields: Object.fromEntries(entries), revision, interactionId };
}

/** The service deps the tool needs; injectable so a test can run the real path. */
export type EditInteractionServices = Pick<
  NaturalLanguageEditDeps,
  "loadInteraction" | "listOpenSurfaces" | "applyField"
> & {
  /**
   * Publish a correction as a new draft linked to the record it amends. Separate
   * from `applyField` because it must create a new card, never touch the record.
   */
  publishAmendment?: (input: {
    interactionId: string;
    plan: unknown;
    /** The mailbox stamp for the new draft, so the card it publishes matches its readback. */
    capabilityStamp?: {
      capability?: EmailSurfaceCapability;
      senderLabel?: string;
      senderAddress?: string;
    };
  }) => Promise<{
    interactionId: string;
    surfaceId: string;
    draftVersion: number;
    /** True when the correction rewrote the card already on screen. */
    amended?: boolean;
    plan?: unknown;
    slots?: Record<string, unknown>;
    missingRequired?: string[];
  }>;
  /**
   * The record an unqualified correction is about: the named one, or the newest
   * of any status when nothing is named and no draft is open.
   */
  loadExecutedCandidate?: (input: {
    interactionId?: string;
    allowNewest: boolean;
  }) => Promise<Awaited<ReturnType<NaturalLanguageEditDeps["loadInteraction"]>>>;
};

/**
 * Publish the correction of a record that already ran.
 *
 * Returns null when this turn cannot amend (no publisher wired, or there is
 * nothing to change), so the caller falls through to the ordinary paths and
 * their own error messages.
 */
async function amendExecuted(
  services: EditInteractionServices,
  input: {
    record: NonNullable<Awaited<ReturnType<NaturalLanguageEditDeps["loadInteraction"]>>>;
    fields: Record<string, unknown>;
    schema: InteractionSurfaceSchema;
    /** The mailbox state for the new draft, so its readback is not a guess. */
    capabilityStamp?: {
      capability?: EmailSurfaceCapability;
      sender?: DraftSender;
    };
  },
): Promise<EditInteractionResult | null> {
  if (!services.publishAmendment) return null;
  const amended = buildAmendment({
    plan: input.record.plan,
    fields: input.fields,
    schema: input.schema,
    ...(input.record.userEditedFields ? { userEditedFields: input.record.userEditedFields } : {}),
  });
  if (!amended.ok) {
    // No stored plan means there is nothing to correct from; the caller reports
    // the record as finished instead of pretending it can amend it.
    if (amended.error === "invalid_plan") return null;
    return {
      ok: false,
      error: amended.error,
      ...(amended.error === "no_change" ? { reply: "这次修改没有改变任何字段。" } : {}),
    };
  }
  let published: Awaited<ReturnType<NonNullable<EditInteractionServices["publishAmendment"]>>>;
  try {
    published = await services.publishAmendment({
      interactionId: input.record.id,
      plan: amended.plan,
      ...(input.capabilityStamp
        ? {
            capabilityStamp: {
              ...(input.capabilityStamp.capability
                ? { capability: input.capabilityStamp.capability }
                : {}),
              ...(input.capabilityStamp.sender?.label
                ? { senderLabel: input.capabilityStamp.sender.label }
                : {}),
              ...(input.capabilityStamp.sender?.address
                ? { senderAddress: input.capabilityStamp.sender.address }
                : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof InteractionCardOccupiedError) {
      // One live card per intent: this thread already has a card the correction
      // would have to overwrite. Say so and change nothing, rather than discard
      // the draft the person is looking at.
      return {
        ok: false,
        error: "card_in_progress",
        reply: "这个线程里还有一张同类卡片没处理完，先处理或取消它，我再改这条已完成的记录。",
      };
    }
    throw error;
  }
  // The correction is a new draft, and the model is told what that draft holds — not what it
  // asked for — so a correction that leaves a required value out is not described as complete.
  const readback =
    published.plan && published.slots
      ? readbackFromStored({
          plan: published.plan as InteractionPlan,
          slots: published.slots,
          draftVersion: published.draftVersion,
          ...(input.capabilityStamp?.capability
            ? { capability: input.capabilityStamp.capability }
            : {}),
          ...(input.capabilityStamp?.sender ? { sender: input.capabilityStamp.sender } : {}),
        })
      : undefined;
  return {
    ok: true,
    amendment: true,
    interactionId: published.interactionId,
    surfaceId: published.surfaceId,
    draftVersion: published.draftVersion,
    skippedFields: amended.skippedFields,
    confirmationInvalidated: true,
    ...(readback
      ? {
          fields: readback.fields,
          missingRequired: readback.missingRequired,
          actionable: readback.actionable,
          blockedBy: readback.blockedBy,
          ...(readback.sender ? { sender: readback.sender } : {}),
        }
      : {}),
    // A second correction of the same record rewrites the card already on screen;
    // saying "new" there would be a claim the timeline contradicts.
    reply: published.amended
      ? "已更新这张关联草稿，请在卡片上确认后再执行。"
      : "已新建一张关联草稿，请在卡片上确认后再执行。",
  };
}

export async function editInteraction(
  ctx: RunContext,
  args: Record<string, unknown>,
  services: EditInteractionServices,
): Promise<EditInteractionResult> {
  if (!isA2uiFeatureEnabled()) {
    return { ok: false, error: "Interactive cards are not enabled on this server." };
  }
  const parsed = parseArgs(args);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { run } = ctx;
  // The schema the edit is validated against comes from the registry, so the
  // model cannot widen the fields by naming new ones.
  const open = await services.listOpenSurfaces({ spaceId: run.spaceId, threadId: run.threadId });
  const target = parsed.interactionId
    ? open.find((surface) => surface.taskId === parsed.interactionId)
    : open.length === 1
      ? open[0]
      : undefined;
  const capability = capabilityForIntent(target?.intent);

  // A record that already ran is found too, because a correction of it is a new
  // draft that names it. Resolve which row the edit is really about first.
  const executedTarget =
    target?.status === "executed"
      ? await services.loadInteraction(target.taskId)
      : !target
        ? await (services.loadExecutedCandidate?.({
            interactionId: parsed.interactionId,
            allowNewest: open.length === 0,
          }) ??
            // A caller without the loader still learns that the card finished,
            // rather than "there is no card".
            (parsed.interactionId
              ? services.loadInteraction(parsed.interactionId)
              : (async () => {
                  const including = await services.listOpenSurfaces({
                    spaceId: run.spaceId,
                    threadId: run.threadId,
                    includeExecuted: true,
                  });
                  const newest = including[0];
                  return newest ? services.loadInteraction(newest.taskId) : null;
                })()))
        : null;

  if (executedTarget?.status === "succeeded") {
    // The record stays exactly as it is. What the user gets is a new draft that
    // names it, so the correction has its own revision and its own confirmation
    // instead of rewriting history.
    const executedCapability = capability ?? capabilityForIntent(executedTarget.intent);
    // The mailbox state for the new draft, resolved once from the connection the person has.
    let amendmentStamp: { capability?: EmailSurfaceCapability; sender?: DraftSender } = {};
    try {
      amendmentStamp = await interactionPublishCapability(ctx, { intent: executedTarget.intent });
    } catch {
      // A correction still publishes without the stamp; it simply says less about the mailbox.
      amendmentStamp = {};
    }
    const amendment = await amendExecuted(services, {
      record: executedTarget,
      fields: parsed.fields,
      schema: executedCapability?.schema ?? fallbackSchema(),
      capabilityStamp: {
        ...(amendmentStamp.capability ? { capability: amendmentStamp.capability } : {}),
        ...(amendmentStamp.sender ? { sender: amendmentStamp.sender } : {}),
      },
    });
    if (amendment) return amendment;
    return { ok: false, error: "already_executed" };
  }

  const result = await applyNaturalLanguageEdit(services, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    interactionId: parsed.interactionId,
    schema: capability?.schema ?? fallbackSchema(),
    fields: parsed.fields,
    revision: parsed.revision,
  });

  if (!result.ok) {
    if (result.error === "ambiguous_target") {
      // Ask which card; never edit one of them on a guess.
      const candidates = open.map((surface) => ({
        interactionId: surface.taskId,
        label: surface.label,
      }));
      return {
        ok: false,
        error: "ambiguous_target",
        candidates,
        reply: `你指的是哪张卡片？${candidates.map((entry) => entry.label).join("、")}`,
      };
    }
    return { ok: false, error: result.error };
  }

  // The stored row is read back rather than described from the request, so the model is told what
  // the card became. `result.values` is the caller's own intent, not evidence. A caller without
  // the plumbing to read it back gets the edit result alone rather than a failed edit.
  const stored = await services.loadInteraction(result.interactionId).catch(() => null);
  const storedPlan = stored?.plan ?? null;
  const capabilityStamp: { capability?: EmailSurfaceCapability; sender?: DraftSender } = storedPlan
    ? await interactionPublishCapability(ctx, storedPlan as InteractionPlan).catch(() => ({}))
    : {};
  const readback = storedPlan
    ? readbackFromStored({
        plan: storedPlan as InteractionPlan,
        slots: stored?.slots ?? {},
        draftVersion: stored?.draftVersion ?? result.draftVersion,
        ...(stored?.status ? { interactionStatus: stored.status } : {}),
        ...(capabilityStamp.capability ? { capability: capabilityStamp.capability } : {}),
        ...(capabilityStamp.sender ? { sender: capabilityStamp.sender } : {}),
      })
    : undefined;
  return {
    ok: true,
    interactionId: result.interactionId,
    surfaceId: result.surfaceId,
    draftVersion: result.draftVersion,
    skippedFields: result.skippedFields,
    confirmationInvalidated: result.confirmationInvalidated,
    ...(readback
      ? {
          fields: readback.fields,
          missingRequired: readback.missingRequired,
          actionable: readback.actionable,
          blockedBy: readback.blockedBy,
          ...(readback.sender ? { sender: readback.sender } : {}),
        }
      : {}),
    reply: result.nudge,
  };
}

export const interactionEditTools: ToolHandlers = {
  async edit_interaction(ctx, call) {
    return call.finish(await editInteraction(ctx, call.args, servicesFor(ctx)));
  },
};

/**
 * Build the service deps from the run. Kept next to the handler so the tool and
 * the HTTP route cannot drift into different behaviour.
 */
export function servicesFor(ctx: RunContext): EditInteractionServices {
  const { deps, run } = ctx;
  const prisma = deps.prisma;
  return {
    loadInteraction: async (interactionId) => {
      const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
      if (!row) return null;
      return {
        id: row.id,
        spaceId: row.spaceId,
        threadId: row.threadId,
        intent: row.intent,
        status: row.status,
        draftVersion: row.draftVersion,
        confirmedVersion: row.confirmedVersion,
        slots:
          row.slots && typeof row.slots === "object" && !Array.isArray(row.slots)
            ? (row.slots as Record<string, unknown>)
            : {},
        userEditedFields: userEditedFieldNames(row.plan),
        // The readback after an edit reports the stored plan, not the caller's request.
        plan: row.plan,
      };
    },
    listOpenSurfaces: async ({ spaceId, threadId }) => {
      const rows = await prisma.interaction.findMany({
        where: {
          spaceId,
          threadId,
          // The same set the kernel lets `edit_interaction` rewrite. A denylist
          // here would offer a superseded or expired card as a live draft.
          status: { in: [...EDITABLE_STATUSES] },
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          intent: true,
          status: true,
          title: true,
          summary: true,
          surfaces: { select: { surfaceId: true }, orderBy: { updatedAt: "desc" }, take: 1 },
        },
      });
      return rows
        .filter((row) => row.surfaces.length > 0)
        .map((row) => ({
          taskId: row.id,
          surfaceId: row.surfaces[0]!.surfaceId,
          intent: row.intent,
          label: row.title ?? row.summary ?? row.intent,
          status: surfaceStatusFor(row.status),
        }));
    },
    loadExecutedCandidate: async ({ interactionId, allowNewest }) => {
      const load = async (id: string | undefined) => {
        if (!id) return null;
        const row = await prisma.interaction.findUnique({ where: { id } });
        if (!row) return null;
        return {
          id: row.id,
          spaceId: row.spaceId,
          threadId: row.threadId,
          intent: row.intent,
          status: row.status,
          draftVersion: row.draftVersion,
          confirmedVersion: row.confirmedVersion,
          slots:
            row.slots && typeof row.slots === "object" && !Array.isArray(row.slots)
              ? (row.slots as Record<string, unknown>)
              : {},
          userEditedFields: userEditedFieldNames(row.plan),
          plan: row.plan,
        };
      };
      if (interactionId) return load(interactionId);
      if (!allowNewest) return null;
      // Nothing named and no draft open: the newest card in the thread is the
      // one the user means, whether it is a draft or a finished record.
      const newest = await prisma.interaction.findFirst({
        where: {
          spaceId: run.spaceId,
          threadId: run.threadId,
          status: { notIn: ["cancelled"] },
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      return load(newest?.id);
    },
    publishAmendment: async ({ interactionId, plan, capabilityStamp }) => {
      const parsed = InteractionPlanSchema.parse(plan);
      // One kernel path decides create-or-amend. The open-card lookup may find a
      // card for this intent already (the first correction), and inserting then
      // would collide with the partial unique index.
      const published = await publishOrAmend(prisma, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        plan: parsed,
        // A draft is only ready when its required values are all present. The status is derived
        // from what the compile actually found, so a correction that leaves a required value out
        // is not labelled ready while the confirm gate refuses it.
        status: "ready_for_review",
        // The record this draft corrects. The original row is never rewritten.
        amendsInteractionId: interactionId,
        // The same mailbox facts the readback reports, so the card and the result agree.
        ...(capabilityStamp?.capability ? { capability: capabilityStamp.capability } : {}),
        ...(capabilityStamp?.senderLabel ? { senderLabel: capabilityStamp.senderLabel } : {}),
        ...(capabilityStamp?.senderAddress ? { senderAddress: capabilityStamp.senderAddress } : {}),
      });
      await deps.events.notify(run.threadId, published.eventSeq).catch((error) => {
        // The card is persisted; a missed wake-up is picked up on the next read.
        void error;
      });
      return {
        interactionId: published.interactionId,
        surfaceId: published.surfaceId,
        draftVersion: published.draftVersion,
        amended: published.amended,
        // What was stored, so the caller can describe the draft it created rather than the plan
        // it asked for.
        plan: published.plan,
        slots: published.slots,
        ...(published.missingRequired?.length
          ? { missingRequired: published.missingRequired }
          : {}),
      };
    },
    applyField: async (input) => {
      // The same write the card's own field edit performs, including the
      // revision bump and the republish of this surface.
      const written = await updateInteractionFieldService(prisma, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId || run.botId,
        interactionId: input.interactionId,
        expectedDraftVersion: input.expectedDraftVersion,
        name: input.name,
        value: input.value,
      });
      return { draftVersion: written.draftVersion };
    },
  };
}

export type { ToolCall };
