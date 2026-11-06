// @vitest-environment jsdom

import { compileInteractionSurface } from "@matebot/a2ui-adapter";
import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { parseNativeCatalog } from "./a2ui-catalog";

/**
 * Mobile parity for the generic compiler. The phone must render the same
 * schema the server compiled — and, where it cannot, it must say so explicitly
 * instead of dropping a required action silently.
 */

const emailSchema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true },
    { name: "subject", label: "Subject", kind: "text", required: true },
    { name: "body", label: "Message", kind: "longText", required: true },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

async function compile(schema: InteractionSurfaceSchema, values: Record<string, unknown>) {
  const result = await compileInteractionSurface({ schema, values, surfaceId: "s-1" });
  if (!result.ok) throw new Error(result.error);
  return result.messages;
}

function flatten(nodes: Array<{ type: string; children?: unknown[] }>): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.type);
    if (Array.isArray(node.children)) {
      out.push(...flatten(node.children as Array<{ type: string; children?: unknown[] }>));
    }
  }
  return out;
}

describe("mobile parses a compiled surface", () => {
  it("renders the fields the server compiled", async () => {
    const messages = await compile(emailSchema, { to: "a@example.com", subject: "Hi", body: "x" });
    const parsed = parseNativeCatalog(messages);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const types = flatten(parsed.nodes as Array<{ type: string; children?: unknown[] }>);
    expect(types.filter((type) => type === "TextField")).toHaveLength(3);
    expect(types).toContain("Button");
  });

  it("keeps the compiled labels so the phone matches the web card", async () => {
    const messages = await compile(emailSchema, { to: "a@example.com", subject: "Hi", body: "x" });
    const parsed = parseNativeCatalog(messages);
    if (!parsed.ok) throw new Error("expected a parseable catalog");
    const text = JSON.stringify(parsed.nodes);
    for (const label of ["To", "Subject", "Message", "Send"]) expect(text).toContain(label);
  });

  it("carries the action id and revision so the phone can submit", async () => {
    const messages = await compile(emailSchema, { to: "a@example.com", subject: "Hi", body: "x" });
    const parsed = parseNativeCatalog(messages);
    if (!parsed.ok) throw new Error("expected a parseable catalog");
    const json = JSON.stringify(parsed.nodes);
    // Without these the mobile button cannot identify the draft it submits.
    expect(json).toContain("interaction.action.send");
    expect(json).toContain("revision");
  });

  // Components the phone cannot draw must be refused with the name, not dropped.
  it("refuses an unsupported component and names it", async () => {
    const parsed = parseNativeCatalog([
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s-1",
          components: [{ id: "root", component: "Tabs", children: [] }],
        },
      },
    ]);
    expect(parsed).toMatchObject({ ok: false, component: "Tabs" });
  });
});
