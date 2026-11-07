import type { InteractionPlan } from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import {
  A2UI_SURFACE_NUDGE,
  interactionRequiredApp,
  surfaceNudgeFor,
  unknownCapabilityNotice,
  validateDecisionForCapability,
} from "@matebot/core";
import { getLogger } from "@matebot/logging";
import { isA2uiFeatureEnabled } from "./a2ui-feature.js";
import {
  interactionCapabilityFromRows,
  loadEmailReconnectRefs,
  loadOwnerEmailConnections,
  loadProviderReadiness,
} from "./interaction-email-capability.js";
import { publishInteractionSurface } from "./interaction-publish.js";
import type { RunContext } from "./run-context.js";
import { runLeaseFor } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const EMAIL_REQUIRED_FIELDS = ["to", "subject", "body"] as const;
const EMAIL_OPTIONAL_FIELDS = ["from", "cc"] as const;

/** A calendar draft needs a name; its entries are optional in the first pass. */
const CALENDAR_FIELDS: { name: string; required: boolean }[] = [
  { name: "name", required: true },
  { name: "events", required: false },
];

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

/** Fill the calendar slots so the resumed surface always has the name and entries. */
export function normalizeCalendarPlan(plan: InteractionPlan): InteractionPlan {
  if (plan.intent !== "calendar.create" && plan.intent !== "calendar.compose") return plan;
  const byName = new Map(plan.fields.map((field) => [field.name, field]));
  const known = new Set(CALENDAR_FIELDS.map((field) => field.name));
  const fields = CALENDAR_FIELDS.map((field) => {
    const existing = byName.get(field.name);
    if (existing) return existing;
    return { name: field.name, required: field.required, status: "missing" as const };
  });
  for (const field of plan.fields) {
    if (!known.has(field.name)) fields.push(field);
  }
  return { ...plan, fields };
}

export function normalizeInteractionPlan(plan: InteractionPlan): InteractionPlan {
  return normalizeCalendarPlan(normalizeEmailComposePlan(plan));
}

/** The one line the turn should say after publishing; nothing else belongs in prose. */
function surfaceNudgeReply(capability: EmailSurfaceCapability | undefined): string | undefined {
  const state = surfaceNudgeFor({ capability, lifecycle: "draft" });
  return state ? A2UI_SURFACE_NUDGE[state] : undefined;
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
  const plan = normalizeInteractionPlan(parsed.data);
  const { deps, run } = ctx;

  // Spec §6.3: the server rules on the capability before a surface exists. The
  // plan's intent is the model's proposal; only a registered, implemented
  // capability may render. An unregistered intent gets the human-readable
  // fallback instead of a card that cannot work.
  const verdict = validateDecisionForCapability({
    taskIdentity: plan.intent,
    capabilityCandidates: [plan.intent],
    missingFields: plan.fields.filter((field) => field.status === "missing").map((f) => f.name),
    presentationChoice: "form",
    version: 1,
  });
  if (!verdict.ok) {
    return {
      error: "unknown_capability",
      reply: unknownCapabilityNotice(),
    };
  }

  try {
    const published = await publishInteractionSurface(deps.prisma, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      plan,
      lease: runLeaseFor(deps, run.id),
      ...(await interactionPublishCapability(ctx, plan)),
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
      /**
       * Without these the model cannot address this card on the next turn:
       * `edit_interaction` needs the id and the revision the card shows.
       */
      revision: published.draftVersion,
      ...(published.capability ? { capability: published.capability } : {}),
      /** The only words the turn should add; the card holds everything else. */
      reply: surfaceNudgeReply(published.capability),
    };
  } catch (error) {
    return {
      error: `Could not present the draft (${error instanceof Error ? error.message : "unknown error"}).`,
    };
  }
}

/** Stamp the app's three-state so the card knows whether it can act yet. */
async function interactionPublishCapability(
  ctx: RunContext,
  plan: InteractionPlan,
): Promise<{ capability?: EmailSurfaceCapability; status?: InteractionLifecycleStatus }> {
  const app = interactionRequiredApp(plan.intent);
  if (!app) return {};
  const userId = ctx.context?.userId;
  if (!userId) {
    return { capability: "not_connected", status: "needs_connection" };
  }
  const owner = { spaceId: ctx.run.spaceId, userId };
  const connections = await loadOwnerEmailConnections(ctx.deps.prisma, owner);
  const managed = ctx.deps.connectors?.managed?.("composio");
  const context = {
    operationId: "interaction.preflight",
    traceId: "interaction.preflight",
    spaceId: owner.spaceId,
    userId,
    signal: ctx.context.signal ?? new AbortController().signal,
  };
  const reconnectRefs = await loadEmailReconnectRefs(managed?.listReconnectRefs, context);
  const providerReady = await loadProviderReadiness(managed, context, connections);
  const snapshot = interactionCapabilityFromRows(
    plan.intent,
    connections,
    reconnectRefs,
    providerReady,
  );
  return {
    capability: snapshot.surfaceCapability,
    ...(snapshot.interactionNeedsConnection ? { status: "needs_connection" as const } : {}),
  };
}

export const interactionTools: ToolHandlers = {
  async present_interaction(ctx, call) {
    return call.finish(await presentInteraction(ctx, call));
  },
};
