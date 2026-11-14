import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { SURFACE_COPY_KEYS, surfaceReasonCopy, surfaceStatusCopy } from "./surface-status-copy.js";

describe("surfaceStatusCopy", () => {
  it("names a copy key for every status", () => {
    for (const status of INTERACTION_STATUSES) {
      expect(SURFACE_COPY_KEYS, status).toContain(surfaceStatusCopy({ status }).titleKey);
    }
  });

  it("tells a replaced card apart from an expired one", () => {
    expect(surfaceStatusCopy({ status: "superseded" }).titleKey).not.toBe(
      surfaceStatusCopy({ status: "expired" }).titleKey,
    );
  });

  it("gives a retry label exactly to the two retryable statuses", () => {
    expect(surfaceStatusCopy({ status: "expired" }).actionKey).toBe("action.retry");
    expect(surfaceStatusCopy({ status: "failed" }).actionKey).toBe("action.retry");
    expect(surfaceStatusCopy({ status: "superseded" }).actionKey).toBeUndefined();
    expect(surfaceStatusCopy({ status: "succeeded" }).actionKey).toBeUndefined();
  });

  // An in-doubt email must ask a question, never claim an outcome.
  it("asks about an in-doubt send", () => {
    expect(surfaceStatusCopy({ status: "unknown" })).toMatchObject({
      titleKey: "status.unknown",
      actionKey: "action.check_status",
    });
  });

  it("has a reason line for every reason key", () => {
    for (const reason of [
      "rule.user",
      "rule.team",
      "setting.approval",
      "effect.irreversible",
    ] as const) {
      expect(SURFACE_COPY_KEYS, reason).toContain(surfaceReasonCopy(reason));
    }
  });
});
