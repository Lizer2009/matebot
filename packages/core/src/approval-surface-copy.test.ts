import { describe, expect, it } from "vitest";
import { approvalDenyLabel, relabelApprovalActionsForSlack } from "./approval-surface-copy.js";

describe("approvalDenyLabel", () => {
  it("keeps Deny on the thread and says Skip on Slack", () => {
    expect(approvalDenyLabel("thread")).toBe("Deny");
    expect(approvalDenyLabel("slack")).toBe("Skip");
  });

  it("relabels only the deny action on an approval ask", () => {
    const slack = relabelApprovalActionsForSlack({
      kind: "ask",
      text: "Allow send?",
      approvalEffectId: "eff-1",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(slack.actions).toEqual([
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Skip" },
    ]);
    expect(
      relabelApprovalActionsForSlack({
        kind: "ask",
        text: "Which city?",
        status: "pending",
        actions: [{ id: "deny", label: "Deny" }],
      }).actions,
    ).toEqual([{ id: "deny", label: "Deny" }]);
  });
});
