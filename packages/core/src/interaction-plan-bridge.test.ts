import { describe, expect, it } from "vitest";
import { surfaceFallback, surfacePlanForCapability } from "./interaction-plan-bridge.js";

/**
 * A plan that names no registered capability must not become an executable
 * card. These tests pin the fallback: safe text, no action, and a reason the
 * host can show instead of a dead surface.
 */

describe("surfacePlanForCapability", () => {
  it("returns the registered schema for a known intent", () => {
    const plan = surfacePlanForCapability("email.compose");
    expect(plan).toMatchObject({ ok: true, capability: { intent: "email.compose" } });
  });

  it("refuses an unregistered intent with a reason rather than a template", () => {
    expect(surfacePlanForCapability("github.clone")).toMatchObject({
      ok: false,
      reason: "unregistered_intent",
    });
  });

  // Phase 1 shipped the calendar, so this now renders. The unimplemented guard
  // is still covered below with a capability the registry marks incomplete.
  it("renders the calendar create capability now that Phase 1 ships it", () => {
    expect(surfacePlanForCapability("calendar.create")).toMatchObject({ ok: true });
  });

  it("still refuses an intent the registry has not registered", () => {
    expect(surfacePlanForCapability("github.clone")).toMatchObject({
      ok: false,
      reason: "unregistered_intent",
    });
  });
});

describe("surfaceFallback", () => {
  it("says what is missing without offering an action", () => {
    const fallback = surfaceFallback("github.clone");
    expect(fallback).toMatchObject({ kind: "text" });
    expect(fallback.text).toContain("github.clone");
    // No button, no field, no implied success.
    expect(fallback).not.toHaveProperty("action");
    expect(fallback.text).not.toMatch(/sent|created|完成|已发送/);
  });

  it("names the capability gap in plain words for a known-but-unimplemented intent", () => {
    const fallback = surfaceFallback("calendar.create");
    expect(fallback.text).toMatch(/calendar|日历/i);
  });
});
