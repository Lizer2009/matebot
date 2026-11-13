import { describe, expect, it } from "vitest";
import type { InteractionLifecycleStatus } from "./interaction-runtime.js";
import {
  emailDeliveryOutcome,
  emailExecutionSurfaceFields,
  emailSurfaceBlockFields,
  emailSurfaceTemplateFromBlock,
  resolveEmailSurfaceLifecycle,
  resolveEmailSurfaceTemplate,
} from "./interaction-template.js";

describe("email surface template matrix", () => {
  it("maps the eight PR-C′ cells", () => {
    const cells: Array<{
      capability?: "not_connected" | "requires_reauth" | "ready";
      interactionStatus: InteractionLifecycleStatus;
      effectStatus?: string;
      template: string;
      lifecycle: string;
    }> = [
      {
        capability: "not_connected",
        interactionStatus: "needs_connection",
        template: "email-connection-card",
        lifecycle: "draft",
      },
      {
        capability: "requires_reauth",
        interactionStatus: "needs_connection",
        template: "email-reauth-card",
        lifecycle: "draft",
      },
      {
        capability: "ready",
        interactionStatus: "ready_for_review",
        template: "email-draft-card",
        lifecycle: "draft",
      },
      {
        capability: "ready",
        interactionStatus: "executing",
        effectStatus: "intended",
        template: "action-submitting-card",
        lifecycle: "submitting",
      },
      {
        capability: "ready",
        interactionStatus: "executing",
        effectStatus: "ambiguous",
        template: "action-progress-card",
        lifecycle: "executing",
      },
      {
        capability: "ready",
        interactionStatus: "succeeded",
        effectStatus: "completed",
        template: "action-result-success",
        lifecycle: "succeeded",
      },
      {
        capability: "ready",
        interactionStatus: "failed",
        effectStatus: "failed",
        template: "action-result-failed",
        lifecycle: "failed",
      },
      {
        capability: "ready",
        interactionStatus: "unknown",
        effectStatus: "ambiguous",
        template: "action-reconcile-card",
        lifecycle: "unknown",
      },
    ];
    for (const cell of cells) {
      expect(
        resolveEmailSurfaceTemplate({
          intent: "email.compose",
          capability: cell.capability,
          interactionStatus: cell.interactionStatus,
          effectStatus: cell.effectStatus,
        }),
        `${cell.interactionStatus}/${cell.effectStatus ?? "-"}/${cell.capability}`,
      ).toBe(cell.template);
      expect(
        resolveEmailSurfaceLifecycle({
          interactionStatus: cell.interactionStatus,
          effectStatus: cell.effectStatus,
        }),
      ).toBe(cell.lifecycle);
    }
  });

  it("lets execution outcomes outrank a stale mailbox stamp", () => {
    expect(
      resolveEmailSurfaceTemplate({
        intent: "email.compose",
        capability: "not_connected",
        interactionStatus: "succeeded",
      }),
    ).toBe("action-result-success");
    expect(
      resolveEmailSurfaceTemplate({
        intent: "email.send",
        capability: "requires_reauth",
        interactionStatus: "unknown",
        effectStatus: "ambiguous",
      }),
    ).toBe("action-reconcile-card");
  });

  it("stamps providerMessageId and error only when present", () => {
    expect(
      emailSurfaceBlockFields({
        intent: "email.compose",
        capability: "ready",
        interactionStatus: "succeeded",
        effectStatus: "completed",
        providerMessageId: " msg-1 ",
      }),
    ).toEqual({
      // The kernel status travels with the block so a host never has to infer it from the
      // six-value lifecycle; see surface-stamp.ts.
      status: "succeeded",
      template: "action-result-success",
      lifecycle: "succeeded",
      capability: "ready",
      providerMessageId: "msg-1",
    });
    expect(
      emailSurfaceBlockFields({
        intent: "email.compose",
        interactionStatus: "failed",
        error: "Could not send the email",
      }),
    ).toMatchObject({
      template: "action-result-failed",
      lifecycle: "failed",
      error: "Could not send the email",
    });
  });

  // The batch-A defect in one assertion: every closed status used to fall through the email
  // runtime's branches into `email-draft-card`, so a replaced card arrived editable with a
  // working Send. The kernel status now owns the template, and the email rules may only refine
  // a card that is still open.
  it("never lets the email rules turn a closed status back into a draft", () => {
    for (const status of ["superseded", "expired", "cancelled"] as const) {
      const stamps = emailSurfaceBlockFields({
        intent: "email.compose",
        interactionStatus: status,
      });
      expect(stamps.template, status).toBe(
        status === "superseded"
          ? "action-superseded-card"
          : status === "expired"
            ? "action-expired-card"
            : "action-cancelled-card",
      );
      expect(stamps.status, status).toBe(status);
    }
  });

  // The writer used to ask the email resolver for every intent. That function returns
  // `email-draft-card` for anything that is not mail, so a calendar draft — and a finished
  // calendar card — arrived looking like a live email form. Stamp owns non-mail templates.
  it("never hands a calendar card an email template", () => {
    for (const status of [
      "collecting",
      "ready_for_review",
      "awaiting_approval",
      "needs_connection",
      "unknown",
      "sent",
      "executed",
      "succeeded",
      "confirmed",
      "superseded",
      "expired",
      "failed",
      "cancelled",
    ] as const) {
      const stamps = emailSurfaceBlockFields({
        intent: "calendar.create",
        interactionStatus: status,
      });
      expect(stamps.template.startsWith("email-"), status).toBe(false);
    }
    expect(
      emailSurfaceBlockFields({
        intent: "calendar.create",
        interactionStatus: "ready_for_review",
      }).template,
    ).toBe("action-draft-card");
  });

  // The two email rules that survive, because they are about an open draft's mailbox rather than
  // about a lifecycle state: no connection, and a failed send whose grant is gone.
  it("still refines an open draft from the mailbox stamp", () => {
    expect(
      emailSurfaceBlockFields({
        intent: "email.compose",
        capability: "requires_reauth",
        interactionStatus: "ready_for_review",
      }).template,
    ).toBe("email-reauth-card");
    expect(
      emailSurfaceBlockFields({
        intent: "email.compose",
        capability: "ready",
        interactionStatus: "failed",
        effectStatus: "failed",
        error: "The connection is no longer active. Ask the user to reconnect.",
      }).template,
    ).toBe("email-reauth-card");
  });

  it("prefers a server template stamp on the block", () => {
    expect(
      emailSurfaceTemplateFromBlock({
        template: "action-progress-card",
        capability: "ready",
        intent: "email.compose",
      }),
    ).toBe("action-progress-card");
    expect(
      emailSurfaceTemplateFromBlock({
        lifecycle: "unknown",
        capability: "ready",
        intent: "email.compose",
      }),
    ).toBe("action-reconcile-card");
    expect(
      emailSurfaceTemplateFromBlock({
        capability: "not_connected",
        intent: "email.compose",
      }),
    ).toBe("email-connection-card");
  });
});

describe("emailExecutionSurfaceFields", () => {
  it("stamps only execution outcomes so overlay can leave connection cards alone", () => {
    expect(
      emailExecutionSurfaceFields({ intent: "email.compose", status: "needs_connection" }),
    ).toEqual({});
    expect(
      emailExecutionSurfaceFields({
        intent: "email.compose",
        status: "unknown",
        capability: "ready",
      }),
    ).toMatchObject({
      template: "action-reconcile-card",
      lifecycle: "unknown",
    });
  });
});

describe("emailDeliveryOutcome", () => {
  it("classifies timeouts as UNKNOWN for the reconcile card", () => {
    expect(emailDeliveryOutcome({ error: "Request timed out" })).toBe("unknown");
    expect(emailDeliveryOutcome({ error: "Could not send", outcome: "unknown" })).toBe("unknown");
    expect(emailDeliveryOutcome({ error: "A recipient is required" })).toBe("failed");
  });
});
