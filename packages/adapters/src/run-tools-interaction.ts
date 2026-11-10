import type { InteractionPlan } from "@matebot/contracts";
import { InteractionPlanSchema } from "@matebot/contracts";
import type { EmailSurfaceCapability, InteractionLifecycleStatus } from "@matebot/core";
import {
  A2UI_SURFACE_NUDGE,
  interactionRequiredApp,
  surfaceNudgeFor,
  timingFields,
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
import type { DraftSender } from "./interaction-readback.js";
import { describeDraftForModel } from "./interaction-readback.js";
import type { RunContext } from "./run-context.js";
import { runLeaseFor } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const EMAIL_REQUIRED_FIELDS = ["to", "subject", "body"] as const;
/**
 * Fields the card lets a person fill.
 *
 * `from` is deliberately absent. The sending mailbox is decided by the connection, and the card
 * shows it as a read-only row, so a `from` field would be a control that does nothing — and a
 * readback that reported it would tell the model the card has a field nobody can edit. Older
 * rows may still carry one; readers keep tolerating it.
 */
const EMAIL_OPTIONAL_FIELDS = ["cc"] as const;

/** A calendar draft needs a name; its entries are optional in the first pass. */
/**
 * The calendar slots the registered capability declares.
 *
 * Kept equal to `CALENDAR_SCHEMA` in `interaction-capability.ts`. A draft that
 * normalises to a different set renders fields the schema does not have and omits
 * fields it does — which is how a calendar card came out with `events` twice and no
 * start, end, or timezone at all.
 */
const CALENDAR_FIELDS: { name: string; required: boolean }[] = [
  { name: "name", required: true },
  { name: "start", required: true },
  { name: "end", required: true },
  { name: "timezone", required: false },
  { name: "allDay", required: false },
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

/** Fill the calendar slots so the resumed surface always has the schema's fields. */
export function normalizeCalendarPlan(plan: InteractionPlan): InteractionPlan {
  if (plan.intent !== "calendar.create" && plan.intent !== "calendar.compose") return plan;
  const byName = new Map(plan.fields.map((field) => [field.name, field]));
  const fields = CALENDAR_FIELDS.map((field) => {
    const existing = byName.get(field.name);
    if (existing) return existing;
    return { name: field.name, required: field.required, status: "missing" as const };
  });
  // Any other field the model sent is carried through untouched, so a batch list
  // still reaches the execute path. The surface renders the schema's fields; a
  // field outside the schema is data, not a control.
  const known = new Set(CALENDAR_FIELDS.map((field) => field.name));
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
  const planStartedAt = Date.now();
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
  // §9.6: the server now knows which surface to build, before it builds it.
  getLogger().info("a2ui.plan_ready", {
    ...timingFields({
      metric: "plan-ready",
      ms: Date.now() - planStartedAt,
      origin: "run-created",
    }),
    "surface.intent": plan.intent,
    "surface.resolved_from": verdict.capability.intent,
    "surface.fields": plan.fields.length,
  });

  try {
    const capabilityStamp = await interactionPublishCapability(ctx, plan);
    const published = await publishInteractionSurface(deps.prisma, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      plan,
      lease: runLeaseFor(deps, run.id),
      // The stamp carries the connection's label for the card's read-only row; the publisher
      // only accepts the label, because an address is not something it can vouch for.
      ...(capabilityStamp.capability ? { capability: capabilityStamp.capability } : {}),
      ...(capabilityStamp.status ? { status: capabilityStamp.status } : {}),
      ...(capabilityStamp.sender ? { senderLabel: capabilityStamp.sender.label } : {}),
    });
    await deps.events.notify(run.threadId, published.eventSeq).catch((error) => {
      getLogger().error("interaction surface realtime notification", error);
    });
    // What the card actually became, so the next sentence is written from the card rather than
    // from the plan this turn submitted. That substitution is what produced "the recipient,
    // subject and body are filled in" over a card with no controls. A publisher that cannot
    // report what it stored simply contributes no readback rather than failing the turn.
    const readback = published.plan
      ? describeDraftForModel({
          plan: published.plan,
          slots: published.slots ?? {},
          draftVersion: published.draftVersion,
          ...(published.capability ? { capability: published.capability } : {}),
          ...(capabilityStamp.sender ? { sender: capabilityStamp.sender } : {}),
        })
      : undefined;
    // One list of empty required fields. The readback derives it from the stored slots and the
    // declared fields, which is what the confirm gate reads; the publisher's own list is only a
    // fallback for a card whose readback could not be built. Two keys of the same name in one
    // result would let the later one silently win.
    const missingRequired = readback?.missingRequired ?? published.missingRequired ?? [];
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
      ...(readback
        ? {
            fields: readback.fields,
            missingRequired,
            actionable: readback.actionable,
            blockedBy: readback.blockedBy,
            ...(readback.sender ? { sender: readback.sender } : {}),
          }
        : {}),
      /**
       * The declared required fields still empty. The card is published and every field is
       * editable, so this is not a failure — but a reply that calls the draft complete while
       * this list is non-empty is exactly the misreport the field audit found, so the model is
       * given the list and told what it means.
       */
      ...(missingRequired.length
        ? {
            notice: `The card is on screen with ${missingRequired.join(", ")} still empty. Tell the user which fields need a value; do not say the draft is complete.`,
          }
        : {}),
      /** The only words the turn should add; the card holds everything else. */
      reply: surfaceNudgeReply(published.capability),
    };
  } catch (error) {
    return {
      error: `Could not present the draft (${error instanceof Error ? error.message : "unknown error"}).`,
    };
  }
}

/**
 * Stamp the app's three-state so the card knows whether it can act yet.
 *
 * Only the intent decides this, so that is all it asks for. Callers that hold a full stored plan
 * pass it; callers that only know the intent do not have to invent a plan-shaped object.
 */
export async function interactionPublishCapability(
  ctx: RunContext,
  plan: { intent: string },
): Promise<{
  capability?: EmailSurfaceCapability;
  status?: InteractionLifecycleStatus;
  sender?: DraftSender;
}> {
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
    // The connection's own label, never a claim about the sending address: `displayName` is
    // whatever the client passed when the connection was created (often the card's title), so
    // an address is only offered when the server actually learned one from the provider.
    ...(snapshot.connection ? { sender: { label: snapshot.connection.displayName } } : {}),
  };
}

export const interactionTools: ToolHandlers = {
  async present_interaction(ctx, call) {
    return call.finish(await presentInteraction(ctx, call));
  },
};
