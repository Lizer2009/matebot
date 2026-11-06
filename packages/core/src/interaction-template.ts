import type { EmailSurfaceCapability } from "./interaction-preflight.js";
import type { InteractionLifecycleStatus } from "./interaction-runtime.js";

/**
 * Catalog template ids for email.compose / email.send (design §4.4).
 * Hosts switch on this instead of intent-only.
 */
export const EMAIL_SURFACE_TEMPLATES = [
  "email-connection-card",
  "email-reauth-card",
  "email-draft-card",
  "action-submitting-card",
  "action-progress-card",
  "action-result-success",
  "action-result-failed",
  "action-reconcile-card",
] as const;

export type EmailSurfaceTemplate = (typeof EMAIL_SURFACE_TEMPLATES)[number];

/** Timeline lifecycle stamp. Submitting is instantaneous (VALIDATING). */
export const EMAIL_SURFACE_LIFECYCLES = [
  "draft",
  "submitting",
  "executing",
  "succeeded",
  "failed",
  "unknown",
] as const;

export type EmailSurfaceLifecycle = (typeof EMAIL_SURFACE_LIFECYCLES)[number];

export type EmailSurfaceTemplateInput = {
  intent?: string;
  capability?: EmailSurfaceCapability;
  interactionStatus: InteractionLifecycleStatus;
  /** ExternalEffect.status. D′/E′ consume `ambiguous` as in-flight / UNKNOWN. */
  effectStatus?: string | null;
};

export function isEmailSurfaceIntent(intent: string | undefined): boolean {
  return intent === "email.compose" || intent === "email.send";
}

const EXECUTION_STATUSES: ReadonlySet<InteractionLifecycleStatus> = new Set([
  "executing",
  "succeeded",
  "failed",
  "unknown",
]);

/**
 * Collapse Interaction + effect onto a surface lifecycle.
 * `unknown` stays unknown so E′ can reconcile without a new table.
 */
export function resolveEmailSurfaceLifecycle(
  input: Pick<EmailSurfaceTemplateInput, "interactionStatus" | "effectStatus">,
): EmailSurfaceLifecycle {
  if (input.interactionStatus === "succeeded") return "succeeded";
  if (input.interactionStatus === "failed") return "failed";
  if (input.interactionStatus === "unknown") return "unknown";
  if (input.interactionStatus === "executing") {
    if (input.effectStatus === "intended" || input.effectStatus == null) return "submitting";
    return "executing";
  }
  return "draft";
}

/**
 * Template = f(intent, capability, interaction, effect).
 * Connection cards win only while the draft is still in preflight; execution
 * outcomes (progress / success / failed / UNKNOWN) outrank mailbox stamps.
 */
export function resolveEmailSurfaceTemplate(
  input: EmailSurfaceTemplateInput,
): EmailSurfaceTemplate {
  if (!isEmailSurfaceIntent(input.intent)) return "email-draft-card";
  const lifecycle = resolveEmailSurfaceLifecycle(input);
  if (lifecycle === "submitting") return "action-submitting-card";
  if (lifecycle === "executing") return "action-progress-card";
  if (lifecycle === "succeeded") return "action-result-success";
  if (lifecycle === "failed") return "action-result-failed";
  if (lifecycle === "unknown") return "action-reconcile-card";
  if (input.capability === "requires_reauth") return "email-reauth-card";
  if (input.capability === "not_connected" || input.interactionStatus === "needs_connection") {
    return "email-connection-card";
  }
  return "email-draft-card";
}

/** Fields stamped onto `a2ui_surface` so hosts do not invent a parallel card kind. */
export function emailSurfaceBlockFields(
  input: EmailSurfaceTemplateInput & {
    providerMessageId?: string | null;
    error?: string | null;
  },
): {
  template: EmailSurfaceTemplate;
  lifecycle: EmailSurfaceLifecycle;
  capability?: EmailSurfaceCapability;
  providerMessageId?: string;
  error?: string;
} {
  const lifecycle = resolveEmailSurfaceLifecycle(input);
  const template = resolveEmailSurfaceTemplate(input);
  const providerMessageId = input.providerMessageId?.trim();
  const error = input.error?.trim();
  return {
    template,
    lifecycle,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(error ? { error } : {}),
  };
}

/** Prefer a server template stamp; otherwise derive from capability + lifecycle. */
export function emailSurfaceTemplateFromBlock(block: {
  template?: EmailSurfaceTemplate;
  lifecycle?: EmailSurfaceLifecycle;
  capability?: EmailSurfaceCapability;
  intent?: string;
}): EmailSurfaceTemplate {
  if (block.template && (EMAIL_SURFACE_TEMPLATES as readonly string[]).includes(block.template)) {
    return block.template;
  }
  const interactionStatus = interactionStatusFromLifecycle(block.lifecycle, block.capability);
  return resolveEmailSurfaceTemplate({
    intent: block.intent,
    capability: block.capability,
    interactionStatus,
    effectStatus: effectStatusFromLifecycle(block.lifecycle),
  });
}

function interactionStatusFromLifecycle(
  lifecycle: EmailSurfaceLifecycle | undefined,
  capability: EmailSurfaceCapability | undefined,
): InteractionLifecycleStatus {
  if (lifecycle === "succeeded") return "succeeded";
  if (lifecycle === "failed") return "failed";
  if (lifecycle === "unknown") return "unknown";
  if (lifecycle === "submitting" || lifecycle === "executing") return "executing";
  if (capability === "not_connected" || capability === "requires_reauth") return "needs_connection";
  return "ready_for_review";
}

function effectStatusFromLifecycle(lifecycle: EmailSurfaceLifecycle | undefined): string | null {
  if (lifecycle === "submitting") return "intended";
  if (lifecycle === "executing" || lifecycle === "unknown") return "ambiguous";
  if (lifecycle === "succeeded") return "completed";
  if (lifecycle === "failed") return "failed";
  return null;
}

/**
 * Snapshot overlay / E′ hook: only execution outcomes, so a collecting
 * connection card is not rewritten as a draft.
 */
export function emailExecutionSurfaceFields(input: {
  intent?: string;
  status: InteractionLifecycleStatus | string;
  capability?: EmailSurfaceCapability;
  providerMessageId?: string | null;
  error?: string | null;
}): ReturnType<typeof emailSurfaceBlockFields> | Record<string, never> {
  if (!isEmailSurfaceIntent(input.intent)) return {};
  if (!EXECUTION_STATUSES.has(input.status as InteractionLifecycleStatus)) return {};
  const status = input.status as InteractionLifecycleStatus;
  return emailSurfaceBlockFields({
    intent: input.intent,
    capability: input.capability,
    interactionStatus: status,
    effectStatus:
      status === "executing" || status === "unknown"
        ? "ambiguous"
        : status === "succeeded"
          ? "completed"
          : "failed",
    providerMessageId: input.providerMessageId,
    error: input.error,
  });
}

/** Map a provider delivery failure onto failed vs UNKNOWN (timeout / ambiguous). */
export function emailDeliveryOutcome(input: {
  error?: string;
  outcome?: "failed" | "unknown";
}): "failed" | "unknown" {
  if (input.outcome === "unknown") return "unknown";
  if (input.outcome === "failed") return "failed";
  const error = input.error?.toLowerCase() ?? "";
  if (
    error.includes("timed out") ||
    error.includes("timeout") ||
    error.includes("aborted") ||
    error.includes("uncertain") ||
    error.includes("ambiguous")
  ) {
    return "unknown";
  }
  return "failed";
}
