import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
import type { InteractionCapability, NaturalLanguageEditDeps } from "@matebot/core";
import {
  applyNaturalLanguageEdit,
  buildAmendment,
  findInteractionCapability,
  interactionCapabilityForIntent,
  userEditedFieldNames,
} from "@matebot/core";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import { updateInteractionFieldService } from "./interaction-field-writer.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

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

export type EditInteractionResult =
  | {
      ok: true;
      interactionId: string;
      surfaceId: string;
      draftVersion: number;
      skippedFields: string[];
      confirmationInvalidated: boolean;
      /** The only words the turn should add. */
      reply: string;
    }
  | {
      ok: true;
      /** True when this created a linked draft instead of editing in place. */
      amendment: true;
      interactionId: string;
      surfaceId: string;
      draftVersion: number;
      skippedFields: string[];
      confirmationInvalidated: true;
      reply: string;
    }
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
  }) => Promise<{ interactionId: string; surfaceId: string; draftVersion: number }>;
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
  },
): Promise<EditInteractionResult | null> {
  if (!services.publishAmendment) return null;
  const amended = buildAmendment({
    plan: input.record.plan,
    fields: input.fields,
    schema: input.schema,
    ...(input.record.userEditedFields
      ? { userEditedFields: input.record.userEditedFields }
      : {}),
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
  const published = await services.publishAmendment({
    interactionId: input.record.id,
    plan: amended.plan,
  });
  return {
    ok: true,
    amendment: true,
    interactionId: published.interactionId,
    surfaceId: published.surfaceId,
    draftVersion: published.draftVersion,
    skippedFields: amended.skippedFields,
    confirmationInvalidated: true,
    reply: "已新建一张关联草稿，请在卡片上确认后再执行。",
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
    const amendment = await amendExecuted(services, {
      record: executedTarget,
      fields: parsed.fields,
      schema: executedCapability?.schema ?? fallbackSchema(),
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

  return {
    ok: true,
    interactionId: result.interactionId,
    surfaceId: result.surfaceId,
    draftVersion: result.draftVersion,
    skippedFields: result.skippedFields,
    confirmationInvalidated: result.confirmationInvalidated,
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
      };
    },
    listOpenSurfaces: async ({ spaceId, threadId }) => {
      const rows = await prisma.interaction.findMany({
        where: {
          spaceId,
          threadId,
          status: { notIn: ["cancelled", "failed", "unknown"] },
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          intent: true,
          status: true,
          confirmedVersion: true,
          draftVersion: true,
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
          status:
            row.status === "succeeded"
              ? ("executed" as const)
              : row.confirmedVersion !== null && row.confirmedVersion === row.draftVersion
                ? ("approved" as const)
                : ("draft" as const),
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
    publishAmendment: async ({ interactionId, plan }) => {
      const { publishInteractionSurface } = await import("./interaction-publish.js");
      const parsed = InteractionPlanSchema.parse(plan);
      const published = await publishInteractionSurface(prisma, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        plan: parsed,
        status: "ready_for_review",
        // The record this draft corrects. The original row is never rewritten.
        amendsInteractionId: interactionId,
      });
      await deps.events.notify(run.threadId, published.eventSeq).catch((error) => {
        // The card is persisted; a missed wake-up is picked up on the next read.
        void error;
      });
      return {
        interactionId: published.interactionId,
        surfaceId: published.surfaceId,
        draftVersion: published.draftVersion,
      };
    },
    applyField: async (input) => {
      // The same write the card's own field edit performs, including the
      // revision bump and the republish of this surface.
      await updateInteractionFieldService(prisma, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId || run.botId,
        interactionId: input.interactionId,
        expectedDraftVersion: input.expectedDraftVersion,
        name: input.name,
        value: input.value,
      });
      return { draftVersion: input.expectedDraftVersion + 1 };
    },
  };
}

export type { ToolCall };
