import { isEditableStatus, isOpenStatus } from "@matebot/core";
import { describe, expect, it } from "vitest";

/**
 * The route used to map every unrecognised status to "draft", which rendered a
 * superseded card as a live draft with a working Send button.
 */
describe("edit target and card status", () => {
  it("does not treat a superseded card as editable", () => {
    expect(isEditableStatus("superseded")).toBe(false);
  });

  it("does not treat an expired card as editable", () => {
    expect(isEditableStatus("expired")).toBe(false);
  });

  it("treats the three open states as editable", () => {
    for (const status of ["collecting", "ready_for_review", "awaiting_approval"]) {
      expect(isEditableStatus(status)).toBe(true);
      expect(isOpenStatus(status)).toBe(true);
    }
  });

  // A card that is only marked stale is still the user's card; the column must not
  // remove it from the edit targets (spec E-refresh / AC-8b).
  it("keeps staleness out of the edit decision", () => {
    expect(isEditableStatus("collecting")).toBe(true);
  });
});
