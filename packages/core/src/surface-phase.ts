import type { SurfaceAffordance } from "./surface-affordance.js";
import { surfaceAffordanceFor } from "./surface-affordance.js";
import type { SurfaceTemplate } from "./surface-stamp.js";
import { isSurfaceTemplate, surfaceStampFor } from "./surface-stamp.js";

/**
 * A block written before `status` existed still carries a template. Read that rather than
 * treating every un-stamped card as a live draft — that is how a finished send kept a Send
 * button.
 */
function affordanceHintFromTemplate(
  template: SurfaceTemplate,
): { status?: string; lifecycle?: string } | undefined {
  switch (template) {
    case "action-submitting-card":
      return { lifecycle: "submitting" };
    case "action-progress-card":
      return { lifecycle: "executing" };
    case "action-result-success":
      return { lifecycle: "succeeded" };
    case "action-result-failed":
      return { lifecycle: "failed" };
    case "action-reconcile-card":
      return { lifecycle: "unknown" };
    case "action-superseded-card":
      return { status: "superseded" };
    case "action-expired-card":
      return { status: "expired" };
    case "action-cancelled-card":
      return { status: "cancelled" };
    default:
      return undefined;
  }
}

/**
 * The phase a card is drawn in, and whether its controls are locked.
 *
 * Both hosts used to derive this from the email template alone, which is why a calendar card had
 * no phases at all and a finished calendar card still looked like a form. One function answers
 * for every intent; a host only decides how to draw the answer.
 */
export function surfacePhase(input: {
  intent?: string;
  status?: string;
  template?: string;
  lifecycle?: string;
  capability?: string;
  busy?: boolean;
}): {
  template: SurfaceTemplate;
  phase: SurfaceTemplate;
  locked: boolean;
  settled: boolean;
  affordance: SurfaceAffordance;
} {
  const stamped = input.status
    ? surfaceStampFor({ status: input.status, intent: input.intent })
    : undefined;
  const template =
    (input.template && isSurfaceTemplate(input.template) ? input.template : undefined) ??
    stamped?.template ??
    "action-draft-card";
  const fromTemplate = input.status ? undefined : affordanceHintFromTemplate(template);
  const affordance = surfaceAffordanceFor({
    ...(input.status
      ? { status: input.status }
      : fromTemplate?.status
        ? { status: fromTemplate.status }
        : {}),
    // A block with no lifecycle is a draft: that is what the schema says when the field is
    // omitted. Inventing `none` here would lock a ready email the hosts still render as a form.
    ...(input.lifecycle
      ? { lifecycle: input.lifecycle }
      : fromTemplate?.lifecycle
        ? { lifecycle: fromTemplate.lifecycle }
        : input.status || fromTemplate?.status
          ? {}
          : { lifecycle: "draft" }),
    ...(input.capability ? { capability: input.capability } : {}),
  });
  // A submit in flight from this client outranks a stamp that has not arrived yet.
  const phase: SurfaceTemplate =
    input.busy && affordance.action === "submit" ? "action-progress-card" : template;
  const inFlight = phase === "action-progress-card" || phase === "action-submitting-card";
  return {
    template,
    phase,
    locked: inFlight || !affordance.editable,
    settled: affordance.terminal,
    affordance,
  };
}
