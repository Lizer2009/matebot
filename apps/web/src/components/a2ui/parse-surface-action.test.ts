import { describe, expect, it } from "vitest";
import { parseSurfaceAction } from "./parse-surface-action";

/**
 * The client half of the bridge. The server re-checks everything, but the
 * client must not invent an interaction or revision the surface never carried —
 * that would make a click look like it belongs to a different draft.
 */

const valid = {
  name: "interaction.action.send",
  surfaceId: "surf-1",
  sourceComponentId: "action",
  timestamp: "2026-11-07T00:00:00.000Z",
  context: { interactionId: "ix-1", revision: 3 },
};

describe("parseSurfaceAction", () => {
  it("reads the action id, interaction, and revision the surface carried", () => {
    expect(parseSurfaceAction(valid)).toEqual({
      action: "send",
      interactionId: "ix-1",
      revision: 3,
    });
  });

  it("ignores an action outside the interaction namespace", () => {
    expect(parseSurfaceAction({ ...valid, name: "somethingElse" })).toBeNull();
  });

  it("ignores a payload whose binding did not resolve", () => {
    expect(parseSurfaceAction({ ...valid, context: {} })).toBeNull();
    expect(parseSurfaceAction({ ...valid, context: { interactionId: "ix-1" } })).toBeNull();
    expect(
      parseSurfaceAction({ ...valid, context: { interactionId: "ix-1", revision: "3" } }),
    ).toBeNull();
  });

  it("ignores an unresolvable template path left as an object", () => {
    expect(
      parseSurfaceAction({
        ...valid,
        context: { interactionId: { path: "/interactionId" }, revision: { path: "/revision" } },
      }),
    ).toBeNull();
  });
});
