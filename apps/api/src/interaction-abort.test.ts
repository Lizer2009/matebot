import { afterEach, describe, expect, it } from "vitest";
import {
  clearInFlightEffects,
  inFlightEffectCount,
  registerInFlightEffect,
  requestEffectAbort,
} from "./interaction-abort.js";

/**
 * Aborting a running effect, and the limits of that.
 *
 * §6.5.2 asks for an abort request only where the runtime supports it. This one
 * does: a provider call carries an AbortSignal. What these tests pin is that the
 * request reaches exactly the right controller, never crosses tenants, and that a
 * cancel landing where the work is not running says so instead of claiming success.
 */

afterEach(() => clearInFlightEffects());

describe("requestEffectAbort", () => {
  it("aborts the controller of a running effect in the caller's space", () => {
    const controller = new AbortController();
    registerInFlightEffect({ effectId: "effect-1", spaceId: "space-1", controller });
    expect(requestEffectAbort({ effectId: "effect-1", spaceId: "space-1" })).toEqual({
      aborted: true,
    });
    expect(controller.signal.aborted).toBe(true);
  });

  it("refuses to abort another tenant's effect", () => {
    const controller = new AbortController();
    registerInFlightEffect({ effectId: "effect-1", spaceId: "space-1", controller });
    expect(requestEffectAbort({ effectId: "effect-1", spaceId: "space-2" })).toEqual({
      aborted: false,
      reason: "forbidden",
    });
    expect(controller.signal.aborted).toBe(false);
  });

  it("reports a finished effect as not running, which is the honest answer", () => {
    expect(requestEffectAbort({ effectId: "gone", spaceId: "space-1" })).toEqual({
      aborted: false,
      reason: "not_running",
    });
  });

  it("leaves nothing behind once the caller unregisters", () => {
    const controller = new AbortController();
    const release = registerInFlightEffect({
      effectId: "effect-1",
      spaceId: "space-1",
      controller,
    });
    expect(inFlightEffectCount()).toBe(1);
    release();
    expect(inFlightEffectCount()).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not remove a newer registration when an older one unregisters", () => {
    const first = new AbortController();
    const second = new AbortController();
    const releaseFirst = registerInFlightEffect({
      effectId: "effect-1",
      spaceId: "space-1",
      controller: first,
    });
    registerInFlightEffect({ effectId: "effect-1", spaceId: "space-1", controller: second });
    releaseFirst();
    // The newer run is still abortable.
    expect(requestEffectAbort({ effectId: "effect-1", spaceId: "space-1" })).toEqual({
      aborted: true,
    });
    expect(second.signal.aborted).toBe(true);
  });
});
