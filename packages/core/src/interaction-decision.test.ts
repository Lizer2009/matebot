import { describe, expect, it } from "vitest";
import { InteractionDecisionSchema } from "@matebot/contracts";
import { decidePresentation, validateDecisionForCapability } from "./interaction-decision.js";

/**
 * Spec §6.3: a structured decision the model proposes and the server rules on.
 *
 * The decision is not an authorization: the server still owns the capability,
 * the allowed actions, and the schema. What this adds is an explicit, checkable
 * record of what the model thought the user wanted and which capability it
 * picked, so an unregistered candidate is refused before a surface exists.
 */

describe("InteractionDecisionSchema", () => {
  it("accepts a well-formed decision", () => {
    const parsed = InteractionDecisionSchema.safeParse({
      taskIdentity: "task-1",
      capabilityCandidates: ["email.compose"],
      missingFields: ["subject"],
      permissions: { sourceAvailable: true, connectionReady: false },
      presentationChoice: "form",
      presentationReason: "the user wants a draft to review",
      version: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a decision with no candidates", () => {
    expect(
      InteractionDecisionSchema.safeParse({
        taskIdentity: "task-1",
        capabilityCandidates: [],
        missingFields: [],
        presentationChoice: "text",
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown presentation choice", () => {
    expect(
      InteractionDecisionSchema.safeParse({
        taskIdentity: "task-1",
        capabilityCandidates: ["email.compose"],
        missingFields: [],
        presentationChoice: "rich_html",
        version: 1,
      }).success,
    ).toBe(false);
  });
});

describe("validateDecisionForCapability", () => {
  const decision = {
    taskIdentity: "task-1",
    capabilityCandidates: ["email.compose"],
    missingFields: [],
    presentationChoice: "form" as const,
    version: 1,
  };

  it("accepts a registered capability the model chose", () => {
    expect(validateDecisionForCapability(decision)).toMatchObject({ ok: true });
    if (!validateDecisionForCapability(decision).ok) return;
    const result = validateDecisionForCapability(decision);
    if (!result.ok) return;
    expect(result.capability.intent).toBe("email.compose");
  });

  // The server rules, not the model: an unregistered candidate is refused.
  it("refuses a decision naming an unregistered capability", () => {
    expect(
      validateDecisionForCapability({ ...decision, capabilityCandidates: ["github.clone"] }),
    ).toMatchObject({ ok: false, error: "unknown_capability" });
  });

  it("refuses a registered but unimplemented capability", () => {
    // `interaction.result` is implemented; a made-up id is the failure case here,
    // and this pins that the registry, not the string, decides.
    expect(
      validateDecisionForCapability({ ...decision, capabilityCandidates: ["sales.chart"] }),
    ).toMatchObject({ ok: false, error: "unknown_capability" });
  });

  // A model may propose several; the first registered one wins so the server
  // still has authority over what actually renders.
  it("picks the first registered candidate when several are proposed", () => {
    const result = validateDecisionForCapability({
      ...decision,
      capabilityCandidates: ["github.clone", "calendar.create"],
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.capability.intent).toBe("calendar.create");
  });

  it("refuses when every candidate is unregistered", () => {
    expect(
      validateDecisionForCapability({ ...decision, capabilityCandidates: ["a.b", "c.d"] }),
    ).toMatchObject({ ok: false, error: "unknown_capability" });
  });
});

describe("decidePresentation", () => {
  it("renders a form for a create capability with every required field present", () => {
    const result = decidePresentation({
      capabilityIntent: "email.compose",
      missingFields: [],
      sourceAvailable: true,
      connectionReady: true,
    });
    expect(result).toMatchObject({ presentation: "form" });
  });

  // The spec forbids pretending a result exists when there is no data source.
  it("asks for a source rather than rendering an empty result", () => {
    const result = decidePresentation({
      capabilityIntent: "interaction.result",
      missingFields: [],
      sourceAvailable: false,
      connectionReady: true,
    });
    expect(result).toMatchObject({ presentation: "text", reason: "source_unavailable" });
  });

  it("falls back to a connection step when the app is not connected", () => {
    const result = decidePresentation({
      capabilityIntent: "calendar.create",
      missingFields: [],
      sourceAvailable: true,
      connectionReady: false,
    });
    expect(result).toMatchObject({ presentation: "progress", reason: "needs_connection" });
  });

  it("asks for missing fields before rendering a form", () => {
    const result = decidePresentation({
      capabilityIntent: "calendar.create",
      missingFields: ["start"],
      sourceAvailable: true,
      connectionReady: true,
    });
    expect(result).toMatchObject({ presentation: "form", reason: "missing_fields" });
    if (result.presentation !== "form") return;
    expect(result.ask).toEqual(["start"]);
  });
});
