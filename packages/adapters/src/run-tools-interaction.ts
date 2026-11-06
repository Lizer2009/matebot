import type { InteractionPlan } from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
import { getLogger } from "@matebot/logging";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import { publishInteractionSurface } from "./interaction-publish.js";
import type { RunContext } from "./run-context.js";
import { runLeaseFor } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const EMAIL_REQUIRED_FIELDS = ["to", "subject", "body"] as const;
const EMAIL_OPTIONAL_FIELDS = ["from", "cc"] as const;

/** Fill missing email.compose slots so the surface always has the draft fields. */
export function normalizeEmailComposePlan(plan: InteractionPlan): InteractionPlan {
  if (plan.intent !== "email.compose" && plan.intent !== "email.send") return plan;
  const byName = new Map(plan.fields.map((field) => [field.name, field]));
  const fields = [
    ...EMAIL_OPTIONAL_FIELDS.map((name) => {
      const existing = byName.get(name);
      if (existing) return existing;
      return { name, required: false, status: "missing" as const };
    }),
    ...EMAIL_REQUIRED_FIELDS.map((name) => {
      const existing = byName.get(name);
      if (existing) return existing;
      return { name, required: true, status: "missing" as const };
    }),
  ];
  const known = new Set<string>([...EMAIL_REQUIRED_FIELDS, ...EMAIL_OPTIONAL_FIELDS]);
  for (const field of plan.fields) {
    if (!known.has(field.name)) fields.push(field);
  }
  return { ...plan, fields };
}

async function presentInteraction(ctx: RunContext, call: ToolCall) {
  if (!isA2uiFeatureEnabled()) {
    return { error: "Interactive drafts are not enabled on this server." };
  }
  const parsed = InteractionPlanSchema.safeParse(call.args.plan ?? call.args);
  if (!parsed.success) {
    return {
      error: "plan must be an InteractionPlan (intent, title, fields, nextStep, riskLevel).",
      details: parsed.error.issues.map((issue) => issue.message),
    };
  }
  const plan = normalizeEmailComposePlan(parsed.data);
  const { deps, run } = ctx;
  try {
    const published = await publishInteractionSurface(deps.prisma, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      plan,
      lease: runLeaseFor(deps, run.id),
    });
    await deps.events.notify(run.threadId, published.eventSeq).catch((error) => {
      getLogger().error("interaction surface realtime notification", error);
    });
    return {
      interactionId: published.interactionId,
      surfaceId: published.surfaceId,
      messageId: published.messageId,
      draftVersion: published.draftVersion,
      intent: plan.intent,
      title: plan.title,
    };
  } catch (error) {
    return {
      error: `Could not present the draft (${error instanceof Error ? error.message : "unknown error"}).`,
    };
  }
}

export const interactionTools: ToolHandlers = {
  async present_interaction(ctx, call) {
    return call.finish(await presentInteraction(ctx, call));
  },
};
