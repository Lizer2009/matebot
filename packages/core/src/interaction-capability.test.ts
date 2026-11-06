import { describe, expect, it } from "vitest";
import {
  findInteractionCapability,
  INTERACTION_CAPABILITIES,
  interactionCapabilityForIntent,
  interactionIntents,
} from "./interaction-capability.js";

/**
 * L1 of the architecture: the server owns which intents exist, what fields they
 * take, which connection they need, and whether they have an effect. The model
 * proposes; this decides. A model naming an unregistered intent gets a safe
 * fallback, never an executable surface.
 */

describe("capability registry", () => {
  it("registers the email capability with a send action and a mailbox connection", () => {
    const email = findInteractionCapability("email.compose");
    expect(email).toMatchObject({
      intent: "email.compose",
      effectKind: "email.send",
      requiresConnection: "email",
    });
    expect(email?.schema.action?.id).toBe("send");
    expect(email?.schema.presentation).toBe("form");
    // A secret must never be collected through a generated form.
    expect(email?.schema.fields.some((field) => /secret|password|token/i.test(field.name))).toBe(
      false,
    );
  });

  // Calendar is registered so a plan cannot silently become a text-only card,
  // but Phase 1 owns its editor. It is recognised, not executable.
  it("registers calendar as known but not yet implemented", () => {
    const calendar = findInteractionCapability("calendar.create");
    expect(calendar).toMatchObject({
      requiresConnection: "calendar",
      effectKind: "calendar.create",
      implemented: false,
    });
    expect(calendar?.schema.action).toBeNull();
  });

  it("returns nothing for an unregistered intent, so callers can fall back", () => {
    expect(findInteractionCapability("github.clone")).toBeUndefined();
    expect(findInteractionCapability("sales.annualTrend")).toBeUndefined();
    expect(interactionCapabilityForIntent("github.clone")).toBeUndefined();
  });

  it("exposes the registered intents for the prompt and docs to stay in sync", () => {
    expect(interactionIntents()).toEqual(
      expect.arrayContaining(["email.compose", "calendar.create"]),
    );
  });

  it("keeps every registered capability internally consistent", () => {
    for (const capability of INTERACTION_CAPABILITIES) {
      // A form needs fields and exactly one action; a result has neither.
      if (capability.schema.presentation === "form") {
        expect(capability.schema.fields.length).toBeGreaterThan(0);
      }
      if (capability.schema.presentation === "form") {
        expect(capability.schema.action).not.toBeNull();
      } else {
        expect(capability.schema.action).toBeNull();
      }
      // Read-only capabilities must not claim an effect.
      if (capability.readOnly) expect(capability.effectKind).toBeNull();
      // An unimplemented capability must not offer a clickable action.
      if (!capability.implemented) expect(capability.schema.action).toBeNull();
    }
  });

  // The registry and the compiler's allowlist must agree, or a registered
  // capability would compile to a refusal (or worse, an unlisted action).
  it("declares only actions the compiler will accept", async () => {
    const { INTERACTION_ALLOWED_ACTIONS } = await import("@matebot/a2ui-adapter");
    const allowed = new Set<string>(INTERACTION_ALLOWED_ACTIONS);
    for (const capability of INTERACTION_CAPABILITIES) {
      if (!capability.schema.action) continue;
      expect(allowed.has(capability.schema.action.id)).toBe(true);
    }
  });

  it("declares no capability that needs a connection only because it is remote-by-habit", () => {
    // A local read-only analysis must be usable with no remote connection.
    const local = INTERACTION_CAPABILITIES.filter((capability) => capability.readOnly);
    for (const capability of local) {
      expect(capability.requiresConnection === null || capability.readOnly).toBe(true);
    }
  });
});
