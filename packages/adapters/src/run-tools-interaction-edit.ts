import type { InteractionSurfaceSchema } from "@matebot/contracts";
import type { InteractionCapability, NaturalLanguageEditDeps } from "@matebot/core";
import {
  applyNaturalLanguageEdit,
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
>;

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

  // A card that already ran is not in the open list, so "no open surface"
  // would read as "there is no card". Say plainly that it is finished instead.
  if (!target) {
    const candidate = parsed.interactionId
      ? await services.loadInteraction(parsed.interactionId)
      : open.length === 0
        ? await services.loadInteraction(
            (
              await services.listOpenSurfaces({
                spaceId: run.spaceId,
                threadId: run.threadId,
                includeExecuted: true,
              })
            )?.[0]?.taskId ?? "",
          )
        : null;
    if (candidate?.status === "succeeded") return { ok: false, error: "already_executed" };
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
