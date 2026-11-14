import { describe, expect, it } from "vitest";
import {
  accountIdFromConnectIntent,
  deliveryNeedsReconnect,
  interactionRequiredApp,
  interactionResumesWhenConnected,
  pickMatchingConnectionCard,
  providerFromConnectIntent,
} from "./interaction-connection.js";
import {
  preflightCalendarCapability,
  preflightEmailCapability,
  selectEmailSendConnection,
} from "./interaction-preflight.js";
import { emailSurfaceBlockFields } from "./interaction-template.js";

const liveAccount = { provider: "gmail", status: "connected", providerRef: "ca_live" };

describe("pickMatchingConnectionCard", () => {
  const gmail = { id: "ix-gmail", intent: "connect.gmail", status: "needs_connection" };
  const calendar = { id: "ix-cal", intent: "connect.googlecalendar", status: "needs_connection" };
  const named = { id: "ix-ca1", intent: "connect.gmail.ca_1", status: "needs_connection" };
  const compose = { id: "ix-mail", intent: "email.compose", status: "needs_connection" };

  it("does not let a newer calendar card swallow a gmail demand", () => {
    expect(
      pickMatchingConnectionCard([calendar, gmail], { app: "email", provider: "gmail" })?.id,
    ).toBe("ix-gmail");
    expect(
      pickMatchingConnectionCard([calendar, gmail], {
        app: "calendar",
        provider: "googlecalendar",
      })?.id,
    ).toBe("ix-cal");
  });

  it("keeps a named account even when a later calendar card is newer", () => {
    expect(
      pickMatchingConnectionCard([calendar, named], {
        app: "email",
        accountId: "ca_1",
      })?.id,
    ).toBe("ix-ca1");
  });

  it("reuses a compose card that is already waiting on the same app", () => {
    expect(
      pickMatchingConnectionCard([calendar, compose], {
        provider: "gmail",
        intent: "connect.gmail",
      })?.id,
    ).toBe("ix-mail");
  });

  it("parses named connect intents", () => {
    expect(providerFromConnectIntent("connect.gmail.ca_1")).toBe("gmail");
    expect(accountIdFromConnectIntent("connect.gmail.ca_1")).toBe("ca_1");
    expect(accountIdFromConnectIntent("connect.gmail")).toBeUndefined();
  });
});

describe("interactionRequiredApp", () => {
  it("maps email and calendar intents to the app they act through", () => {
    expect(interactionRequiredApp("email.compose")).toBe("email");
    expect(interactionRequiredApp("email.send")).toBe("email");
    expect(interactionRequiredApp("calendar.create")).toBe("calendar");
    expect(interactionRequiredApp("calendar.compose")).toBe("calendar");
    expect(interactionRequiredApp("calendar.query")).toBe("calendar");
    expect(interactionRequiredApp("interaction.result")).toBeUndefined();
  });

  it("needs no app for intents that act on nothing external", () => {
    expect(interactionRequiredApp("note.compose")).toBeUndefined();
    expect(interactionRequiredApp(undefined)).toBeUndefined();
  });
});

describe("preflightEmailCapability", () => {
  it("is ready when a live account is connected", () => {
    expect(
      preflightEmailCapability({ connections: [liveAccount], providerReady: { gmail: true } }),
    ).toEqual({
      status: "CONNECTED_AND_READY",
      interactionStatus: null,
      surfaceCapability: "ready",
    });
  });

  it("is not connected when the owner has no mailbox at all", () => {
    expect(preflightEmailCapability({ connections: [] })).toEqual({
      status: "NOT_CONNECTED",
      interactionStatus: "needs_connection",
      surfaceCapability: "not_connected",
    });
  });

  it("is reconnect when the provider lists the account as dead", () => {
    expect(
      preflightEmailCapability({
        connections: [{ ...liveAccount, providerRef: "ca_dead" }],
        reconnectRefs: ["ca_dead"],
      }).status,
    ).toBe("REQUIRES_REAUTH");
  });

  it("is reconnect when the row says error", () => {
    expect(
      preflightEmailCapability({ connections: [{ provider: "gmail", status: "error" }] }).status,
    ).toBe("REQUIRES_REAUTH");
  });

  // The production failure: the local row still said connected while the provider
  // had already revoked the account, so Send went through and failed downstream.
  it("is reconnect when a local connected row is stale against the provider", () => {
    const result = preflightEmailCapability({
      connections: [liveAccount],
      providerReady: { gmail: false },
    });
    expect(result.status).toBe("REQUIRES_REAUTH");
    expect(result.surfaceCapability).toBe("requires_reauth");
  });

  it("keeps trusting a local connected row when the provider cannot answer", () => {
    expect(preflightEmailCapability({ connections: [liveAccount] }).status).toBe(
      "CONNECTED_AND_READY",
    );
    expect(preflightEmailCapability({ connections: [liveAccount], providerReady: {} }).status).toBe(
      "CONNECTED_AND_READY",
    );
  });

  it("is ready when any one of several mailboxes is live", () => {
    expect(
      preflightEmailCapability({
        connections: [
          { provider: "gmail", status: "connected", providerRef: "ca_dead" },
          { provider: "gmail", status: "connected", providerRef: "ca_live" },
        ],
        reconnectRefs: ["ca_dead"],
      }).status,
    ).toBe("CONNECTED_AND_READY");
  });

  it("ignores providers that are not a mailbox", () => {
    expect(
      preflightEmailCapability({
        connections: [{ provider: "googlecalendar", status: "connected" }],
      }).status,
    ).toBe("NOT_CONNECTED");
  });
});

describe("preflightCalendarCapability", () => {
  it("maps a connected calendar and its revoked state", () => {
    expect(
      preflightCalendarCapability({
        connections: [{ provider: "googlecalendar", status: "connected", providerRef: "ca_cal" }],
      }).status,
    ).toBe("CONNECTED_AND_READY");
    expect(
      preflightCalendarCapability({
        connections: [{ provider: "googlecalendar", status: "connected", providerRef: "ca_cal" }],
        providerReady: { googlecalendar: false },
      }).status,
    ).toBe("REQUIRES_REAUTH");
  });
});

describe("selectEmailSendConnection", () => {
  it("never returns a mailbox the provider called dead", () => {
    expect(selectEmailSendConnection([liveAccount], [], { gmail: false })).toBeUndefined();
    expect(selectEmailSendConnection([liveAccount], [], { gmail: true })).toMatchObject({
      providerRef: "ca_live",
    });
  });
});

describe("deliveryNeedsReconnect", () => {
  it("recognises the connector's own dead-connection message", () => {
    expect(
      deliveryNeedsReconnect(
        "The gmail connection is no longer active. Ask the user to reconnect gmail.",
      ),
    ).toBe(true);
  });

  it("recognises expired and revoked authorization text", () => {
    expect(deliveryNeedsReconnect("invalid_grant")).toBe(true);
    expect(deliveryNeedsReconnect("Token has been expired or revoked")).toBe(true);
    expect(deliveryNeedsReconnect("insufficient authentication scopes")).toBe(true);
  });

  it("leaves plain provider failures as ordinary failures", () => {
    expect(deliveryNeedsReconnect("550 Mailbox unavailable")).toBe(false);
    expect(deliveryNeedsReconnect("Request timed out")).toBe(false);
    expect(deliveryNeedsReconnect(undefined)).toBe(false);
  });
});

describe("emailSurfaceBlockFields reconnect mapping", () => {
  it("turns a dead-connection failure into a reconnect card, not a dead end", () => {
    const stamps = emailSurfaceBlockFields({
      intent: "email.compose",
      capability: "ready",
      interactionStatus: "failed",
      effectStatus: "failed",
      error: "The gmail connection is no longer active. Ask the user to reconnect gmail.",
    });
    expect(stamps.template).toBe("email-reauth-card");
  });

  it("keeps an ordinary delivery failure on the retry card", () => {
    const stamps = emailSurfaceBlockFields({
      intent: "email.compose",
      capability: "ready",
      interactionStatus: "failed",
      effectStatus: "failed",
      error: "550 Mailbox unavailable",
    });
    expect(stamps.template).toBe("action-result-failed");
  });
});

describe("interactionResumesWhenConnected", () => {
  it("resumes a waiting calendar surface when the calendar connects", () => {
    expect(
      interactionResumesWhenConnected({
        intent: "calendar.create",
        interactionStatus: "needs_connection",
        provider: "googlecalendar",
      }),
    ).toBe(true);
  });

  it("resumes a waiting email surface when the mailbox connects", () => {
    expect(
      interactionResumesWhenConnected({
        intent: "email.compose",
        interactionStatus: "needs_connection",
        provider: "gmail",
      }),
    ).toBe(true);
  });

  it("does not resume on an app the surface does not act through", () => {
    expect(
      interactionResumesWhenConnected({
        intent: "calendar.create",
        interactionStatus: "needs_connection",
        provider: "gmail",
      }),
    ).toBe(false);
  });

  it("does not resume a surface that is not waiting for a connection", () => {
    expect(
      interactionResumesWhenConnected({
        intent: "calendar.create",
        interactionStatus: "ready_for_review",
        provider: "googlecalendar",
      }),
    ).toBe(false);
  });
});
