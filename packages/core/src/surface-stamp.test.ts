import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { isSurfaceTemplate, surfaceStampFor } from "./surface-stamp.js";

describe("surfaceStampFor", () => {
  // The defect this batch exists to close: a replaced card was stamped the *draft* template, so
  // both hosts drew an editable form with a working Send button for a card already replaced.
  it("never gives a closed card a draft template", () => {
    for (const intent of ["email.compose", "email.send", "calendar.create"]) {
      for (const status of ["superseded", "expired", "cancelled", "succeeded", "failed"] as const) {
        expect(surfaceStampFor({ status, intent }).template, `${intent}/${status}`).not.toMatch(
          /-draft-card$/,
        );
      }
    }
  });

  it("gives each terminal status its own template", () => {
    const templates = (["superseded", "expired", "cancelled"] as const).map(
      (status) => surfaceStampFor({ status, intent: "email.compose" }).template,
    );
    expect(new Set(templates).size).toBe(3);
  });

  it("carries the kernel status so hosts do not have to infer it", () => {
    for (const status of INTERACTION_STATUSES) {
      expect(surfaceStampFor({ status, intent: "email.compose" }).status).toBe(status);
    }
  });

  // `lifecycle` keeps its six values (§4.4): these three never entered submission, and saying so
  // is honest. The truth a host must act on is `status`; a guard test keeps every writer stamping
  // it, so no consumer is left reading `lifecycle` alone.
  it("keeps lifecycle at six values, so a closed card still reads draft there", () => {
    for (const status of ["superseded", "expired", "cancelled"]) {
      expect(surfaceStampFor({ status, intent: "email.compose" }).lifecycle).toBe("draft");
    }
  });

  it("keeps the email templates email owns", () => {
    expect(surfaceStampFor({ status: "ready_for_review", intent: "email.compose" }).template).toBe(
      "email-draft-card",
    );
    expect(surfaceStampFor({ status: "succeeded", intent: "email.compose" }).template).toBe(
      "action-result-success",
    );
  });

  // A calendar card was stamped nothing, and the fallback returned an *email* template, so a
  // cancelled calendar draft rendered as a live email form.
  it("never hands a calendar card an email template", () => {
    for (const status of INTERACTION_STATUSES) {
      const stamp = surfaceStampFor({ status, intent: "calendar.create" });
      expect(stamp.template.startsWith("email-"), `${status}`).toBe(false);
    }
    expect(
      surfaceStampFor({ status: "ready_for_review", intent: "calendar.create" }).template,
    ).toBe("action-draft-card");
  });

  // A 批的已知洞：发信路径写词表外的 `executing`。本批不把它塞进 13 值，也不伪造一个状态。
  it("stamps a progress template for executing without inventing a kernel status", () => {
    const stamp = surfaceStampFor({ status: "executing", intent: "email.compose" });
    expect(stamp.status).toBeUndefined();
    expect(stamp.template).toBe("action-progress-card");
    expect(stamp.lifecycle).toBe("executing");
  });

  it("treats submitting as in flight, not as a draft", () => {
    const stamp = surfaceStampFor({ status: "submitting", intent: "email.compose" });
    expect(stamp.status).toBeUndefined();
    expect(stamp.template).toBe("action-submitting-card");
    expect(stamp.lifecycle).toBe("submitting");
  });

  // A value the vocabulary does not know is not evidence of a draft either: draw it as in doubt,
  // which offers no editable fields, rather than as a form that can be sent.
  it("treats an unknown status as in doubt, not as a draft", () => {
    const stamp = surfaceStampFor({ status: "pending", intent: "email.compose" });
    expect(stamp.status).toBeUndefined();
    expect(stamp.template).toBe("action-reconcile-card");
    expect(stamp.lifecycle).toBe("unknown");
  });

  it("reports whether a template id is one this build can draw", () => {
    expect(isSurfaceTemplate("action-expired-card")).toBe(true);
    for (const value of ["email-draft", "", "action-draft"]) {
      expect(isSurfaceTemplate(value), value).toBe(false);
    }
  });
});
