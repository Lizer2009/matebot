import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { appendInteractionEvent, INTERACTION_EVENT_KINDS } from "./interaction-events.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("appendInteractionEvent", () => {
  it("inserts a published row and never offers an update helper", async () => {
    const create = vi.fn().mockResolvedValue({ id: "ev-1" });
    await appendInteractionEvent({ interactionEvent: { create } } as never, {
      interactionId: "ix-1",
      kind: "published",
      toStatus: "needs_connection",
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        interactionId: "ix-1",
        kind: "published",
        fromStatus: null,
        toStatus: "needs_connection",
        reason: null,
        runId: null,
      },
    });
    expect(INTERACTION_EVENT_KINDS).toContain("settled");
    expect(INTERACTION_EVENT_KINDS).toContain("revived");
  });

  it("has no update or delete path in application source", () => {
    const files = [
      join(here, "interaction-events.ts"),
      join(here, "../../adapters/src/interaction-kernel-store.ts"),
      join(here, "../../adapters/src/interaction-publish.ts"),
    ];
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/interactionEvent\.update/);
    expect(source).not.toMatch(/interactionEvent\.delete/);
    expect(source).not.toMatch(/interactionEvent\.upsert/);
  });
});
