import { decideCancel } from "@matebot/core";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import { cancelInteractionService } from "./interaction-field-writer.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { servicesFor } from "./run-tools-interaction-edit.js";

/**
 * `cancel_interaction`: the model discarding a card the user no longer wants.
 *
 * Same rule as the card's own Discard control: the recorded state decides. A draft
 * that never ran is cancelled; a record that executed, or an action in flight, is
 * refused with the sentence explaining that cancelling would not undo it. The tool
 * has no path to an effect, so "cancel" can never be a way to retract a send.
 */

export type CancelInteractionOutcome =
  | { ok: true; interactionId: string; draftVersion: number; reply: string }
  | { ok: false; error: string; reply?: string };

export async function cancelInteraction(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<CancelInteractionOutcome> {
  if (!isA2uiFeatureEnabled()) {
    return { ok: false, error: "Interactive cards are not enabled on this server." };
  }
  const revision = args.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, error: "revision must be the positive integer shown on the card" };
  }
  const named =
    typeof args.interactionId === "string" && args.interactionId.trim()
      ? args.interactionId.trim()
      : undefined;

  const services = servicesFor(ctx);
  const open = await services.listOpenSurfaces({
    spaceId: ctx.run.spaceId,
    threadId: ctx.run.threadId,
  });
  const target = named ? open.find((surface) => surface.taskId === named) : undefined;
  if (named && !target) {
    // It may already have finished; say that rather than "no such card".
    const record = await services.loadInteraction(named);
    if (!record) return { ok: false, error: "unknown_interaction" };
    if (record.status === "succeeded") {
      return {
        ok: false,
        error: "already_executed",
        reply: "这个操作已经完成，无法撤销。如需更正，我可以新建一张关联草稿。",
      };
    }
  }
  if (!named && open.length > 1) {
    return {
      ok: false,
      error: "ambiguous_target",
      reply: `你指的是哪张卡片？${open.map((entry) => entry.label).join("、")}`,
    };
  }
  const chosen = named ?? open[0]?.taskId;
  if (!chosen) {
    return { ok: false, error: "no_open_surface", reply: "现在没有可以取消的卡片。" };
  }

  const record = await services.loadInteraction(chosen);
  if (!record) return { ok: false, error: "unknown_interaction" };
  // The same decision the route makes, so the two paths cannot disagree. The
  // runtime can abort a provider request here, so a running action becomes an
  // abort request rather than an outright refusal.
  const decision = decideCancel({ status: record.status as never, runtimeCanAbort: true });
  if (!decision.ok) return { ok: false, error: decision.error, reply: decision.message };
  if (decision.status === "abort_requested") {
    // The effect is running. The route owns the abort registry, so the tool says
    // what is true and lets the card's own status settle the outcome.
    return {
      ok: false,
      error: "in_flight",
      reply: "这次操作已经在进行中，无法当作已取消；结果以卡片最终状态为准。",
    };
  }

  try {
    const result = await cancelInteractionService(ctx.deps.prisma, {
      spaceId: ctx.run.spaceId,
      threadId: ctx.run.threadId,
      botId: ctx.run.botId,
      interactionId: chosen,
      expectedDraftVersion: revision,
    });
    if (result.status === "abort_requested") {
      return {
        ok: false,
        error: "in_flight",
        reply: "这次操作已经在进行中，不能再取消。",
      };
    }
    return {
      ok: true,
      interactionId: chosen,
      draftVersion: result.draftVersion,
      reply: "已取消这张卡片。",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not cancel the card";
    return { ok: false, error: message, reply: message };
  }
}

export const interactionCancelTools: ToolHandlers = {
  async cancel_interaction(ctx, call) {
    return call.finish(await cancelInteraction(ctx, call.args));
  },
};

export type { ToolCall };
