import { describe, expect, it } from "vitest";
import { A2UI_SURFACE_NUDGE, surfaceNudgeFor } from "./interaction-nudge.js";
import {
  SIMULATED_CONNECTION_STATES,
  SIMULATED_DELIVERIES,
  SIMULATED_RECONNECT_ERROR,
  simulateCalendarSurface,
  simulateConnectionResume,
  simulatedConnection,
  simulatedConnectionFor,
  simulatedIntentForRequest,
  simulatedIntentSupported,
  simulateEmailSend,
  simulateEmailSurface,
  simulateSendGate,
} from "./interaction-simulation.js";

describe("simulated connection states", () => {
  it("gives every state rows a real workspace could hold", () => {
    expect(simulatedConnection("ready").connections).toHaveLength(1);
    expect(simulatedConnection("not_connected").connections).toEqual([]);
    expect(simulatedConnection("requires_reauth").reconnectRefs).toHaveLength(1);
    // The production shape: the row still says connected, the provider says dead.
    expect(simulatedConnection("stale_local_connected").connections[0]?.status).toBe("connected");
    expect(simulatedConnection("stale_local_connected").providerReady).toEqual({ gmail: false });
  });

  it("covers all four states the matrix documents", () => {
    expect([...SIMULATED_CONNECTION_STATES]).toEqual([
      "not_connected",
      "requires_reauth",
      "ready",
      "stale_local_connected",
    ]);
  });
});

describe("email surface matrix", () => {
  it("offers only Connect for an owner with no mailbox", () => {
    const surface = simulateEmailSurface({
      connection: "not_connected",
      interactionStatus: "needs_connection",
    });
    expect(surface.template).toBe("email-connection-card");
    expect(surface.primaryAction).toBe("connect");
    expect(surface.canSend).toBe(false);
  });

  it("offers only Reconnect when the saved authorization died", () => {
    const surface = simulateEmailSurface({
      connection: "requires_reauth",
      interactionStatus: "needs_connection",
    });
    expect(surface.template).toBe("email-reauth-card");
    expect(surface.primaryAction).toBe("reconnect");
    expect(surface.canSend).toBe(false);
  });

  // The live failure: the row said connected, so the draft kept a Send button that
  // could only fail. The card must ask for reauthorization instead.
  it("offers Reconnect when the local row is stale against the provider", () => {
    const surface = simulateEmailSurface({
      connection: "stale_local_connected",
      interactionStatus: "needs_connection",
    });
    expect(surface.template).toBe("email-reauth-card");
    expect(surface.primaryAction).toBe("reconnect");
    expect(surface.canSend).toBe(false);
  });

  it("offers the single Send gesture for a ready mailbox", () => {
    const surface = simulateEmailSurface({
      connection: "ready",
      interactionStatus: "ready_for_review",
    });
    expect(surface.template).toBe("email-draft-card");
    expect(surface.primaryAction).toBe("send");
    expect(surface.canSend).toBe(true);
  });

  it("shows progress and no button while a send is in flight", () => {
    const surface = simulateEmailSurface({
      connection: "ready",
      interactionStatus: "executing",
      effectStatus: "ambiguous",
    });
    expect(surface.template).toBe("action-progress-card");
    expect(surface.primaryAction).toBe("none");
    expect(surface.canSend).toBe(false);
  });

  it("shows the reconcile card for an UNKNOWN send and never offers Send again", () => {
    const surface = simulateEmailSurface({
      connection: "ready",
      interactionStatus: "unknown",
      effectStatus: "ambiguous",
    });
    expect(surface.template).toBe("action-reconcile-card");
    expect(surface.primaryAction).toBe("check_status");
    expect(surface.canSend).toBe(false);
  });

  it("shows the success card only for a succeeded interaction", () => {
    const surface = simulateEmailSurface({
      connection: "ready",
      interactionStatus: "succeeded",
      effectStatus: "completed",
    });
    expect(surface.template).toBe("action-result-success");
    expect(surface.primaryAction).toBe("none");
  });
});

describe("send outcomes", () => {
  it("reaches the success card only when the provider confirmed the send", () => {
    const sent = simulateEmailSend({ connection: "ready", delivery: "ok" });
    expect(sent.template).toBe("action-result-success");
    expect(sent.lifecycle).toBe("succeeded");
  });

  it("keeps an ordinary provider failure on the retry card", () => {
    const failed = simulateEmailSend({ connection: "ready", delivery: "provider_error" });
    expect(failed.template).toBe("action-result-failed");
    expect(failed.primaryAction).toBe("retry");
  });

  it("treats a timeout as UNKNOWN, not as a failure to retry", () => {
    const unknown = simulateEmailSend({ connection: "ready", delivery: "timeout" });
    expect(unknown.interactionStatus).toBe("unknown");
    expect(unknown.template).toBe("action-reconcile-card");
    expect(unknown.primaryAction).toBe("check_status");
  });

  // The reported bug: the model narrated SMTP advice for a dead Composio account.
  it("maps the dead-connection error onto the reconnect card", () => {
    const revoked = simulateEmailSend({ connection: "ready", delivery: "reconnect_error" });
    expect(revoked.template).toBe("email-reauth-card");
    expect(revoked.primaryAction).toBe("reconnect");
    expect(SIMULATED_RECONNECT_ERROR).toContain("no longer active");
  });

  it("never reports success for any non-ok delivery", () => {
    for (const delivery of SIMULATED_DELIVERIES) {
      const surface = simulateEmailSend({ connection: "ready", delivery });
      if (delivery === "ok") continue;
      expect(surface.template).not.toBe("action-result-success");
      expect(surface.canSend).toBe(false);
    }
  });
});

describe("send gate", () => {
  it("accepts only a live mailbox", () => {
    expect(simulateSendGate({ connection: "ready" }).accepted).toBe(true);
  });

  it("refuses with the reason the card needs", () => {
    expect(simulateSendGate({ connection: "not_connected" })).toEqual({
      accepted: false,
      reason: "not_connected",
    });
    expect(simulateSendGate({ connection: "requires_reauth" }).reason).toBe("requires_reauth");
    expect(simulateSendGate({ connection: "stale_local_connected" }).reason).toBe(
      "requires_reauth",
    );
  });
});

describe("calendar resume after authorization", () => {
  // The reported gap: OAuth finished, the UI said connected, and nothing continued.
  it("resumes a waiting calendar turn once the calendar connects", () => {
    const resumed = simulateConnectionResume({
      intent: "calendar.create",
      interactionStatusBefore: "needs_connection",
      connectedProvider: "googlecalendar",
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.template).toBe("email-draft-card");
  });

  it("does not resume on a different app's authorization", () => {
    expect(
      simulateConnectionResume({
        intent: "calendar.create",
        interactionStatusBefore: "needs_connection",
        connectedProvider: "gmail",
      }),
    ).toEqual({ resumed: false, template: null });
  });

  it("does not resume a draft that was never waiting", () => {
    expect(
      simulateConnectionResume({
        intent: "calendar.create",
        interactionStatusBefore: "ready_for_review",
        connectedProvider: "googlecalendar",
      }).resumed,
    ).toBe(false);
  });
});

describe("post-surface nudge", () => {
  it("asks for confirmation on a plain draft", () => {
    expect(surfaceNudgeFor({ capability: "ready", lifecycle: "draft" })).toBe("presented");
    expect(A2UI_SURFACE_NUDGE.presented).toBe("请在卡片上确认或编辑。");
  });

  it("points at authorization instead when the card waits on it", () => {
    expect(surfaceNudgeFor({ capability: "not_connected", lifecycle: "draft" })).toBe(
      "awaiting_connection",
    );
    expect(surfaceNudgeFor({ capability: "requires_reauth", lifecycle: "draft" })).toBe(
      "reconnect",
    );
  });

  it("says nothing once the card owns a real outcome", () => {
    expect(surfaceNudgeFor({ lifecycle: "executing" })).toBeUndefined();
    expect(surfaceNudgeFor({ lifecycle: "succeeded" })).toBeUndefined();
    expect(surfaceNudgeFor({ lifecycle: "unknown" })).toBeUndefined();
  });

  it("keeps each nudge to one short sentence", () => {
    for (const text of Object.values(A2UI_SURFACE_NUDGE)) {
      expect(text.length).toBeLessThanOrEqual(20);
      expect(text.endsWith("。")).toBe(true);
    }
  });
});

describe("intent mapping for real requests", () => {
  it("maps an email or calendar request to the shipping intent", () => {
    expect(simulatedIntentForRequest("帮我发邮件:给 a@example.com 主题: 秋后问候")).toBe(
      "email.compose",
    );
    expect(simulatedIntentForRequest("确定下周日程，主题和内容自理")).toBe("calendar.create");
  });

  // No surface exists for a shell job, and the simulator must say so rather than
  // map it onto something that would render a card.
  it("maps a computer or shell request to no intent at all", () => {
    expect(
      simulatedIntentForRequest("登录 Github 做一次简单的代码拉取到本地电脑，项目你自选"),
    ).toBeNull();
    expect(simulatedIntentSupported("computer.shell")).toBe(false);
    expect(simulatedIntentSupported("calendar.create")).toBe(true);
  });
});

describe("calendar surfaces", () => {
  // The old simulator forced the email template here, which hid the gap.
  // A non-email intent is stamped with nothing and has no editor.
  it("stamps no email template for a calendar intent", () => {
    const surface = simulateCalendarSurface({
      connection: "not_connected",
      interactionStatus: "needs_connection",
    });
    expect(surface.template).toBeNull();
    expect(surface.capability).toBe("not_connected");
    expect(surface.registered).toBe(true);
    expect(surface.implemented).toBe(false);
  });

  // The honest shortfall: nothing on a calendar surface is tappable today.
  it("offers no action and no editor in any connection state", () => {
    for (const connection of SIMULATED_CONNECTION_STATES) {
      const surface = simulateCalendarSurface({
        connection,
        interactionStatus: connection === "ready" ? "collecting" : "needs_connection",
      });
      expect(surface.action).toBe("none");
      expect(surface.canSend).toBe(false);
      expect(surface.editor).toBe("none");
      expect(surface.implemented).toBe(false);
      expect(surface.gap.length).toBeGreaterThan(0);
    }
  });

  it("still resumes once the calendar connects", () => {
    expect(
      simulateConnectionResume({
        intent: "calendar.create",
        interactionStatusBefore: "needs_connection",
        connectedProvider: "googlecalendar",
      }).resumed,
    ).toBe(true);
  });

  it("models a calendar row with the same four states as a mailbox", () => {
    expect(simulatedConnectionFor("calendar", "ready").connections[0]?.provider).toBe(
      "googlecalendar",
    );
    expect(simulatedConnectionFor("calendar", "stale_local_connected").providerReady).toEqual({
      googlecalendar: false,
    });
    expect(simulatedConnectionFor("email", "ready").connections[0]?.provider).toBe("gmail");
  });
});
