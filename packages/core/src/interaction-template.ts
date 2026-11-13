import { isEmailComposeIntent } from "./interaction-capability.js";
import { deliveryNeedsReconnect } from "./interaction-connection.js";
import type { EmailSurfaceCapability } from "./interaction-preflight.js";
import type { InteractionLifecycleStatus } from "./interaction-runtime.js";
import type { InteractionStatus } from "./interaction-status.js";
import { surfacePhase } from "./surface-phase.js";
import type { SurfaceTemplate } from "./surface-stamp.js";
import { SURFACE_TEMPLATES, surfaceStampFor } from "./surface-stamp.js";

/**
 * Catalog template ids a card may carry (design §4.4).
 * Hosts switch on this instead of intent-only.
 *
 * One list, owned by `surface-stamp.ts`; this name stays because it is what the rest of the
 * package and the block payload already read.
 */
export const EMAIL_SURFACE_TEMPLATES = SURFACE_TEMPLATES;

export type EmailSurfaceTemplate = SurfaceTemplate;

/**
 * The three statuses the email runtime may not refine.
 *
 * They close the card, and the runtime's branches have no case for them, so they used to fall
 * through to `email-draft-card` — a replaced or expired card arrived at the client looking
 * editable. The kernel status owns their template exactly.
 */
const CLOSED_KERNEL_STATUSES: ReadonlySet<string> = new Set(["superseded", "expired", "cancelled"]);

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
  /**
   * The card's status. Wider than the runtime lifecycle on purpose: a closed card reaches the
   * writer as `superseded` / `expired` / `cancelled` from the kernel vocabulary, and narrowing
   * this to the nine runtime values meant those three could never be stamped at all — they fell
   * through to a draft template instead.
   */
  interactionStatus: InteractionLifecycleStatus | InteractionStatus;
  /** ExternalEffect.status. D′/E′ consume `ambiguous` as in-flight / UNKNOWN. */
  effectStatus?: string | null;
  /** Last send error; a reconnect failure keeps the card actionable. */
  error?: string | null;
};

export function isEmailSurfaceIntent(intent: string | undefined): boolean {
  return isEmailComposeIntent(intent);
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
 * Connection cards win only while the draft is still preflight; execution
 * outcomes (progress / success / failed / UNKNOWN) outrank mailbox stamps —
 * except a failure the user can only fix by reconnecting, which returns to the
 * reconnect card so the same surface stays actionable.
 */
export function resolveEmailSurfaceTemplate(
  input: EmailSurfaceTemplateInput,
): EmailSurfaceTemplate {
  if (!isEmailSurfaceIntent(input.intent)) return "email-draft-card";
  const lifecycle = resolveEmailSurfaceLifecycle(input);
  if (lifecycle === "submitting") return "action-submitting-card";
  if (lifecycle === "executing") return "action-progress-card";
  if (lifecycle === "succeeded") return "action-result-success";
  if (lifecycle === "unknown") return "action-reconcile-card";
  if (lifecycle === "failed") {
    return deliveryNeedsReconnect(input.error) ? "email-reauth-card" : "action-result-failed";
  }
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
  status?: InteractionStatus;
  template: SurfaceTemplate;
  lifecycle: EmailSurfaceLifecycle;
  capability?: EmailSurfaceCapability;
  providerMessageId?: string;
  error?: string;
} {
  const inFlight = resolveEmailSurfaceLifecycle(input);
  const inFlightStatus =
    inFlight === "submitting" || inFlight === "executing" ? inFlight : undefined;
  const stamp = surfaceStampFor({
    status: inFlightStatus ?? input.interactionStatus,
    intent: input.intent,
  });
  // The kernel status decides the template. Mail may still refine an *open* card: a mailbox
  // that is not connected (or whose authorization died) shows a connection card, and a send
  // that failed because the grant is gone shows a reconnect card instead of a dead end.
  // Anything else — a closed card, or a card that is not mail — keeps the stamp. Asking the
  // email resolver for a calendar intent used to return `email-draft-card`, so a calendar
  // draft arrived looking like a live email form.
  const template =
    isEmailSurfaceIntent(input.intent) && !CLOSED_KERNEL_STATUSES.has(input.interactionStatus)
      ? resolveEmailSurfaceTemplate(input)
      : stamp.template;
  const providerMessageId = input.providerMessageId?.trim();
  const error = input.error?.trim();
  return {
    ...stamp,
    template,
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
  error?: string | null;
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
    error: block.error,
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

/**
 * The card's visible phase and whether its controls are locked.
 *
 * Mail used to own this; calendar had none. Both now go through `surfacePhase`. This wrapper
 * keeps the email callers compiling and fills the email-derived template only when the caller
 * has not already given a status or template — otherwise a replaced card would be stamped a
 * draft again.
 */
export function emailSurfacePhase(input: {
  template?: EmailSurfaceTemplate;
  lifecycle?: EmailSurfaceLifecycle;
  capability?: EmailSurfaceCapability;
  intent?: string;
  error?: string | null;
  /** A submit is in flight from this client. */
  busy?: boolean;
  status?: string;
}): ReturnType<typeof surfacePhase> {
  const intent = input.intent ?? "email.compose";
  if (input.status || input.template) {
    return surfacePhase({ ...input, intent });
  }
  return surfacePhase({
    ...input,
    intent,
    template: emailSurfaceTemplateFromBlock({ ...input, intent }),
  });
}
