import { describe, expect, it } from "vitest";
import { cardKindForIntent, findInteractionCapability, isActionIntent } from "./interaction-capability.js";
import {
  derivedL0aBlockStatus,
  l0aHostInteractive,
  l0aIntentForBlock,
  stampL0aBlock,
} from "./l0a-capability.js";

describe("l0aIntentForBlock", () => {
  it("names connect / approval / question intents from the live block kinds", () => {
    expect(
      l0aIntentForBlock({
        kind: "app_connect",
        provider: "gmail",
        name: "Gmail",
        description: "",
        logo: null,
        status: "pending",
      }),
    ).toBe("connect.gmail");
    expect(
      l0aIntentForBlock(
        {
          kind: "app_connect",
          provider: "gmail",
          name: "Gmail",
          description: "",
          logo: null,
          status: "pending",
        },
        { accountId: "ca_1" },
      ),
    ).toBe("connect.gmail.ca_1");
    expect(
      l0aIntentForBlock({
        kind: "mcp_approval",
        name: "S",
        serverId: "srv1",
        transport: "sse",
        endpoint: null,
        needsOAuth: true,
        status: "pending",
      }),
    ).toBe("approval.mcp.srv1");
    expect(
      l0aIntentForBlock({
        kind: "ask",
        text: "Allow?",
        approvalEffectId: "eff1",
        status: "pending",
        actions: [],
      }),
    ).toBe("approval.effect.eff1");
    expect(l0aIntentForBlock({ kind: "ask", text: "Which city?", status: "pending" })).toBe(
      "question.clarify",
    );
    expect(l0aIntentForBlock({ kind: "choice", question: "Pick", options: [] })).toBe(
      "question.clarify",
    );
  });
});

describe("L0-A capability prefixes", () => {
  it("treats L0-A prefix intents as action cards without registering A2UI forms", () => {
    expect(cardKindForIntent("connect.gmail")).toBe("action");
    expect(isActionIntent("question.clarify")).toBe(true);
    expect(isActionIntent("approval.mcp.srv1")).toBe(true);
    expect(findInteractionCapability("connect.gmail")).toBeUndefined();
  });

  it("derives legacy block status from the kernel", () => {
    expect(derivedL0aBlockStatus("app_connect", "needs_connection")).toBe("pending");
    expect(derivedL0aBlockStatus("app_connect", "succeeded")).toBe("connected");
    expect(derivedL0aBlockStatus("ask", "awaiting_approval")).toBe("pending");
    expect(derivedL0aBlockStatus("ask", "succeeded")).toBe("answered");
    expect(derivedL0aBlockStatus("mcp_approval", "cancelled")).toBe("dismissed");
  });

  it("hides buttons on a terminal kernel status", () => {
    expect(
      l0aHostInteractive({
        kind: "mcp_approval",
        name: "S",
        serverId: "srv1",
        transport: "sse",
        endpoint: null,
        needsOAuth: true,
        status: "pending",
        cardStatus: "cancelled",
      }),
    ).toBe(false);
    expect(
      l0aHostInteractive({
        kind: "app_connect",
        provider: "gmail",
        name: "Gmail",
        description: "",
        logo: null,
        status: "pending",
        cardStatus: "needs_connection",
      }),
    ).toBe(true);
  });

  it("stamps the kernel row onto the live view", () => {
    expect(
      stampL0aBlock(
        {
          kind: "app_connect",
          provider: "gmail",
          name: "Gmail",
          description: "",
          logo: null,
          status: "connected",
        },
        { interactionId: "ix-1", cardStatus: "needs_connection" },
      ),
    ).toMatchObject({
      interactionId: "ix-1",
      cardStatus: "needs_connection",
      status: "pending",
    });
  });
});
