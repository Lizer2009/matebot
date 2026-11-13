import { isEmailComposeIntent } from "./interaction-capability.js";
import type { InteractionStatus } from "./interaction-status.js";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import type { EmailSurfaceLifecycle } from "./interaction-template.js";

/**
 * The template ids a card may carry.
 *
 * `email-*` are the states the mail editor draws differently. `action-*` are intent-independent,
 * which is what lets a calendar card be a card without borrowing an email template — before this,
 * a calendar draft was stamped nothing and fell back to `email-draft-card`. A closed card has one
 * shared template per terminal kind on purpose: folding a finished card is one design, and two
 * implementations of it is how the two hosts drifted apart.
 */
export const SURFACE_TEMPLATES = [
  "email-connection-card",
  "email-reauth-card",
  "email-draft-card",
  "action-draft-card",
  "action-submitting-card",
  "action-progress-card",
  "action-result-success",
  "action-result-failed",
  "action-reconcile-card",
  "action-superseded-card",
  "action-expired-card",
  "action-cancelled-card",
] as const;

export type SurfaceTemplate = (typeof SURFACE_TEMPLATES)[number];

const TEMPLATES: ReadonlySet<string> = new Set(SURFACE_TEMPLATES);

/** Whether a string is a template this build knows how to draw. */
export function isSurfaceTemplate(value: string): value is SurfaceTemplate {
  return TEMPLATES.has(value);
}

const KERNEL_STATUSES: ReadonlySet<string> = new Set(INTERACTION_STATUSES);


/**
 * The interaction's status onto the two fields a rendered block carries.
 *
 * This is the only place that decides what a card *is* for the hosts. Before it existed the
 * mapping lived in `emailSurfaceBlockFields`, which knew only six email lifecycles and returned
 * `draft` for every status it had no branch for — so `superseded`, `expired` and `cancelled` all
 * reached the client looking editable, with a working Send button.
 *
 * Two inputs are not kernel statuses. `executing` and `submitting` come from the runtime
 * lifecycle, which the kernel vocabulary deliberately does not contain. They get a template and a
 * lifecycle but **no** `status`, so a host falls back to the lifecycle and draws a locked card
 * rather than a fabricated status.
 */
export function surfaceStampFor(input: { status: string; intent?: string }): {
  status?: InteractionStatus;
  lifecycle: EmailSurfaceLifecycle;
  template: SurfaceTemplate;
} {
  const { status } = input;
  const email = isEmailComposeIntent(input.intent);

  if (status === "submitting" || status === "executing") {
    return {
      lifecycle: status === "submitting" ? "submitting" : "executing",
      template: status === "submitting" ? "action-submitting-card" : "action-progress-card",
    };
  }
  if (!KERNEL_STATUSES.has(status)) {
    // An unknown value is not evidence of a draft. Draw it as in doubt, which offers nothing to
    // press, rather than as a form that can be sent.
    return { lifecycle: "unknown", template: "action-reconcile-card" };
  }

  const kernel = status as InteractionStatus;
  const draftTemplate: SurfaceTemplate = email ? "email-draft-card" : "action-draft-card";

  switch (kernel) {
    case "collecting":
    case "ready_for_review":
    case "awaiting_approval":
      return { status: kernel, lifecycle: "draft", template: draftTemplate };
    case "needs_connection":
      return {
        status: kernel,
        lifecycle: "draft",
        template: email ? "email-connection-card" : "action-draft-card",
      };
    case "unknown":
      return { status: kernel, lifecycle: "unknown", template: "action-reconcile-card" };
    case "sent":
    case "executed":
    case "succeeded":
    case "confirmed":
      return { status: kernel, lifecycle: "succeeded", template: "action-result-success" };
    case "failed":
      return { status: kernel, lifecycle: "failed", template: "action-result-failed" };
    case "superseded":
      return { status: kernel, lifecycle: "draft", template: "action-superseded-card" };
    case "expired":
      return { status: kernel, lifecycle: "draft", template: "action-expired-card" };
    case "cancelled":
      return { status: kernel, lifecycle: "draft", template: "action-cancelled-card" };
  }
}
