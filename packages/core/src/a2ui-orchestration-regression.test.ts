import type { InteractionPlan } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import {
  A2UI_SURFACE_NUDGE,
  applyInteractionFieldChange,
  canExecuteConfirmedInteraction,
  confirmInteractionDraftState,
  deliveryNeedsReconnect,
  deriveCollectingStatus,
  emailDeliveryOutcome,
  emailSurfaceBlockFields,
  emailSurfaceTemplateFromBlock,
  interactionRequiredApp,
  requiredFieldsSatisfied,
  resolveEmailSurfaceLifecycle,
  resolveEmailSurfaceTemplate,
  SIMULATED_CONNECTION_STATES,
  simulateEmailSend,
  simulateEmailSurface,
  surfaceNudgeFor,
  resolveEmailSurfaceTemplate as templateFor,
} from "./index.js";

/**
 * One place that pins the whole A2UI orchestration path as it stands on tip:
 * preflight three-state, the single Send gesture, the shell-escape block, the
 * template matrix, the no-optimistic-success rule, UNKNOWN reconciliation,
 * and the three gaps fixed here (calendar resume, revoked mailbox, short copy).
 *
 * Anything that changes a rule should change a row here — that is the point.
 */

const plan: InteractionPlan = {
  intent: "email.compose",
  title: "Send email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved" },
    { name: "subject", value: "Hi", required: true, status: "resolved" },
    { name: "body", value: "Hello", required: true, status: "resolved" },
  ],
  nextStep: "request_approval",
  riskLevel: "medium",
};

describe("A2UI regression: preflight three-state", () => {
  it("separates no account, revoked account, and usable account", () => {
    const statuses = SIMULATED_CONNECTION_STATES.map((state) => ({
      state,
      capability: simulateEmailSurface({ connection: state, interactionStatus: "needs_connection" })
        .capability,
    }));
    expect(statuses).toEqual([
      { state: "not_connected", capability: "not_connected" },
      { state: "requires_reauth", capability: "requires_reauth" },
      { state: "ready", capability: "ready" },
      { state: "stale_local_connected", capability: "requires_reauth" },
    ]);
  });
});

describe("A2UI regression: single Send gesture", () => {
  it("offers exactly one primary action per template", () => {
    const actions = new Set(
      SIMULATED_CONNECTION_STATES.map(
        (connection) =>
          simulateEmailSurface({ connection, interactionStatus: "needs_connection" }).primaryAction,
      ),
    );
    // Connect and reconnect are separate cards; neither shows Send as well.
    expect(actions).toEqual(new Set(["connect", "reconnect"]));
  });

  it("keeps a draft editable and sendable only on a ready mailbox", () => {
    const surface = simulateEmailSurface({
      connection: "ready",
      interactionStatus: "ready_for_review",
    });
    expect(surface.template).toBe("email-draft-card");
    expect(surface.canSend).toBe(true);
    expect(surface.primaryAction).toBe("send");
  });
});

describe("A2UI regression: draft version rules", () => {
  it("clears the confirmation when a field changes after confirm", () => {
    const slots = { to: "a@example.com", subject: "Hi", body: "Hello" };
    const confirmed = confirmInteractionDraftState(
      { status: "ready_for_review", draftVersion: 1, confirmedVersion: null, plan, slots },
      1,
    );
    expect(confirmed).toMatchObject({ ok: true, confirmedVersion: 1, status: "awaiting_approval" });
    if (!confirmed.ok) return;
    const edited = applyInteractionFieldChange(
      {
        status: confirmed.status,
        draftVersion: 1,
        confirmedVersion: confirmed.confirmedVersion,
        plan,
        slots,
      },
      { expectedDraftVersion: 1, name: "body", value: "Hello again" },
    );
    expect(edited).toMatchObject({ ok: true, confirmedVersion: null, draftVersion: 2 });
    if (!edited.ok) return;
    expect(
      canExecuteConfirmedInteraction({
        draftVersion: edited.draftVersion,
        confirmedVersion: edited.confirmedVersion,
        status: edited.status,
      }),
    ).toMatchObject({ ok: false, error: "unconfirmed" });
  });

  it("refuses to confirm while a required field is still empty", () => {
    const incomplete: InteractionPlan = {
      ...plan,
      fields: plan.fields.map((field) =>
        field.name === "to" ? { ...field, value: "", status: "missing" } : field,
      ),
    };
    expect(requiredFieldsSatisfied(incomplete, { to: "", subject: "Hi", body: "Hello" })).toBe(
      false,
    );
    expect(
      deriveCollectingStatus(incomplete, { to: "", subject: "Hi", body: "Hello" }, "collecting"),
    ).toBe("collecting");
    expect(
      confirmInteractionDraftState(
        {
          status: "collecting",
          draftVersion: 1,
          confirmedVersion: null,
          plan: incomplete,
          slots: { to: "", subject: "Hi", body: "Hello" },
        },
        1,
      ),
    ).toMatchObject({ ok: false, error: "not_ready" });
  });
});

describe("A2UI regression: template matrix", () => {
  const matrix = [
    {
      status: "ready_for_review",
      capability: "ready" as const,
      effect: null,
      template: "email-draft-card",
    },
    {
      status: "needs_connection",
      capability: "not_connected" as const,
      effect: null,
      template: "email-connection-card",
    },
    {
      status: "needs_connection",
      capability: "requires_reauth" as const,
      effect: null,
      template: "email-reauth-card",
    },
    {
      status: "executing",
      capability: "ready" as const,
      effect: "intended",
      template: "action-submitting-card",
    },
    {
      status: "executing",
      capability: "ready" as const,
      effect: "ambiguous",
      template: "action-progress-card",
    },
    {
      status: "succeeded",
      capability: "ready" as const,
      effect: "completed",
      template: "action-result-success",
    },
    {
      status: "failed",
      capability: "ready" as const,
      effect: "failed",
      template: "action-result-failed",
    },
    {
      status: "unknown",
      capability: "ready" as const,
      effect: "ambiguous",
      template: "action-reconcile-card",
    },
  ] as const;

  for (const row of matrix) {
    it(`${row.status} + ${row.capability} + ${row.effect ?? "none"} → ${row.template}`, () => {
      expect(
        resolveEmailSurfaceTemplate({
          intent: "email.compose",
          capability: row.capability,
          interactionStatus: row.status,
          effectStatus: row.effect,
        }),
      ).toBe(row.template);
    });
  }

  it("derives the same template from a block that only carries stamps", () => {
    const stamps = emailSurfaceBlockFields({
      intent: "email.compose",
      capability: "ready",
      interactionStatus: "unknown",
      effectStatus: "ambiguous",
    });
    expect(emailSurfaceTemplateFromBlock({ intent: "email.compose", ...stamps })).toBe(
      "action-reconcile-card",
    );
  });

  it("does not let a connection stamp outrank a finished execution", () => {
    expect(
      templateFor({
        intent: "email.compose",
        capability: "requires_reauth",
        interactionStatus: "succeeded",
        effectStatus: "completed",
      }),
    ).toBe("action-result-success");
  });

  it("collapses effect status onto the surface lifecycle", () => {
    expect(
      resolveEmailSurfaceLifecycle({ interactionStatus: "executing", effectStatus: "intended" }),
    ).toBe("submitting");
    expect(
      resolveEmailSurfaceLifecycle({ interactionStatus: "executing", effectStatus: "ambiguous" }),
    ).toBe("executing");
    expect(
      resolveEmailSurfaceLifecycle({ interactionStatus: "unknown", effectStatus: "ambiguous" }),
    ).toBe("unknown");
  });
});

describe("A2UI regression: status comes only from the server", () => {
  it("keeps a provider failure off the success card", () => {
    for (const delivery of ["provider_error", "timeout", "reconnect_error"] as const) {
      const surface = simulateEmailSend({ connection: "ready", delivery });
      expect(surface.template).not.toBe("action-result-success");
      expect(surface.lifecycle).not.toBe("succeeded");
    }
  });

  it("classifies timeouts as UNKNOWN so nothing is retried blindly", () => {
    expect(emailDeliveryOutcome({ error: "Request timed out" })).toBe("unknown");
    expect(emailDeliveryOutcome({ error: "Operation aborted" })).toBe("unknown");
    expect(emailDeliveryOutcome({ error: "550 Mailbox unavailable" })).toBe("failed");
  });
});

describe("A2UI regression: UNKNOWN reconcile", () => {
  it("offers only Check status and blocks a second send", () => {
    const surface = simulateEmailSurface({
      connection: "ready",
      interactionStatus: "unknown",
      effectStatus: "ambiguous",
    });
    expect(surface.template).toBe("action-reconcile-card");
    expect(surface.primaryAction).toBe("check_status");
    expect(surface.canSend).toBe(false);
    expect(
      canExecuteConfirmedInteraction({
        draftVersion: 2,
        confirmedVersion: 2,
        status: "unknown",
      }),
    ).toMatchObject({ ok: false, error: "unknown" });
  });
});

describe("A2UI regression: mail never escapes to a script", () => {
  it("pins email and calendar intents to their native app", () => {
    expect(interactionRequiredApp("email.compose")).toBe("email");
    expect(interactionRequiredApp("calendar.create")).toBe("calendar");
  });
});

describe("A2UI regression: revoked mailbox", () => {
  it("moves the same card to reconnect on the connector's own error", () => {
    const surface = simulateEmailSend({ connection: "ready", delivery: "reconnect_error" });
    expect(surface.template).toBe("email-reauth-card");
    expect(surface.primaryAction).toBe("reconnect");
    expect(surface.canSend).toBe(false);
  });

  it("still calls a plain provider rejection a retryable failure", () => {
    expect(deliveryNeedsReconnect("550 Mailbox unavailable")).toBe(false);
    expect(
      simulateEmailSend({ connection: "ready", delivery: "provider_error" }).primaryAction,
    ).toBe("retry");
  });
});

describe("A2UI regression: post-surface copy", () => {
  it("has one short Chinese line per surface state", () => {
    expect(surfaceNudgeFor({ capability: "ready", lifecycle: "draft" })).toBe("presented");
    expect(A2UI_SURFACE_NUDGE.presented).toBe("请审阅后点发送，尚未发出。");
    expect(A2UI_SURFACE_NUDGE.incomplete).toBe("请先补全收件人和主题。");
    expect(A2UI_SURFACE_NUDGE.awaiting_connection).toBe("授权完成后点卡片继续。");
    expect(A2UI_SURFACE_NUDGE.reconnect).toBe("连接已失效，请在卡片上重新授权。");
  });

  it("says nothing while the card owns a running or finished job", () => {
    for (const lifecycle of ["submitting", "executing", "succeeded", "unknown"] as const) {
      expect(surfaceNudgeFor({ lifecycle })).toBeUndefined();
    }
  });
});
