import { InteractionStatus as ContractStatus, EmailSurfaceTemplate } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { SURFACE_TEMPLATES } from "./surface-stamp.js";

// contracts must not import core (the dependency points the other way), so the thirteen values
// exist twice. These assertions are what keep the copies from drifting.
describe("status vocabulary parity", () => {
  it("matches the contracts enum exactly", () => {
    expect([...ContractStatus.options].sort()).toEqual([...INTERACTION_STATUSES].sort());
  });

  it("keeps every template a stamp can produce inside the contracts enum", () => {
    for (const template of SURFACE_TEMPLATES) {
      expect(EmailSurfaceTemplate.options, template).toContain(template);
    }
  });
});
