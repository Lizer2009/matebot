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
