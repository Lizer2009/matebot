import { describe, expect, it } from "vitest";
import {
  emailCapabilityAllowsSend,
  emailCapabilityToSurface,
  preflightEmailCapability,
  selectEmailSendConnection,
} from "./interaction-preflight.js";

describe("preflightEmailCapability", () => {
  it("maps no rows to NOT_CONNECTED", () => {
    expect(preflightEmailCapability({ connections: [] })).toEqual({
      status: "NOT_CONNECTED",
      interactionStatus: "needs_connection",
      surfaceCapability: "not_connected",
    });
  });

  it("maps only pending gmail to NOT_CONNECTED", () => {
    expect(
      preflightEmailCapability({
        connections: [{ provider: "gmail", status: "pending" }],
      }),
    ).toMatchObject({ status: "NOT_CONNECTED", surfaceCapability: "not_connected" });
  });

  it("maps connected gmail without reconnect refs to READY", () => {
    expect(
      preflightEmailCapability({
        connections: [{ provider: "gmail", status: "connected", providerRef: "ca_1" }],
        reconnectRefs: [],
      }),
    ).toEqual({
      status: "CONNECTED_AND_READY",
      interactionStatus: null,
      surfaceCapability: "ready",
    });
  });

  it("maps connected gmail whose providerRef is reconnecting to REQUIRES_REAUTH", () => {
    expect(
      preflightEmailCapability({
        connections: [{ provider: "gmail", status: "connected", providerRef: "ca_expired" }],
        reconnectRefs: ["ca_expired"],
      }),
    ).toMatchObject({ status: "REQUIRES_REAUTH", surfaceCapability: "requires_reauth" });
  });

  it("maps status error gmail to REQUIRES_REAUTH", () => {
    expect(
      preflightEmailCapability({
        connections: [{ provider: "gmail", status: "error" }],
      }),
    ).toMatchObject({ status: "REQUIRES_REAUTH", interactionStatus: "needs_connection" });
  });

  it("ignores connected slack as not email-capable", () => {
    expect(
      preflightEmailCapability({
        connections: [{ provider: "slack", status: "connected" }],
      }),
    ).toMatchObject({ status: "NOT_CONNECTED" });
  });

  it("treats googlemail as gmail", () => {
    expect(
      preflightEmailCapability({
        connections: [{ provider: "googlemail", status: "connected" }],
      }),
    ).toMatchObject({ status: "CONNECTED_AND_READY" });
  });
});

describe("email send selection", () => {
  it("allows send only when READY", () => {
    expect(emailCapabilityAllowsSend("CONNECTED_AND_READY")).toBe(true);
    expect(emailCapabilityAllowsSend("NOT_CONNECTED")).toBe(false);
    expect(emailCapabilityAllowsSend("REQUIRES_REAUTH")).toBe(false);
  });

  it("picks the ready gmail row", () => {
    const rows = [
      { provider: "slack", status: "connected", id: "s" },
      { provider: "gmail", status: "connected", id: "g", providerRef: "ca_1" },
    ];
    expect(selectEmailSendConnection(rows, [])).toMatchObject({ id: "g" });
    expect(selectEmailSendConnection(rows, ["ca_1"])).toBeUndefined();
  });

  it("maps status onto the surface stamp", () => {
    expect(emailCapabilityToSurface("NOT_CONNECTED")).toBe("not_connected");
    expect(emailCapabilityToSurface("REQUIRES_REAUTH")).toBe("requires_reauth");
    expect(emailCapabilityToSurface("CONNECTED_AND_READY")).toBe("ready");
  });
});
