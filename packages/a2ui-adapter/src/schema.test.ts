import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  A2UI_PNPM_GIT_SPEC,
  A2UI_UPSTREAM_COMMIT,
  A2UI_WEB_CORE_NPM_VERSION,
  compileInteractionPlan,
  DEFAULT_PROTOCOL_FAMILY,
  validateA2uiMessages,
} from "./index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
}

describe("a2ui upstream pin", () => {
  it("pins a full commit SHA (not a floating branch)", () => {
    expect(A2UI_UPSTREAM_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(A2UI_PNPM_GIT_SPEC).toContain(A2UI_UPSTREAM_COMMIT);
    expect(A2UI_PNPM_GIT_SPEC).toContain("path:typescript/core/web_core");
    expect(A2UI_WEB_CORE_NPM_VERSION).toBe("0.15.0");
  });

  it("defaults compile/validate to v0_9", () => {
    expect(DEFAULT_PROTOCOL_FAMILY).toBe("v0_9");
  });
});

describe("dual-track schema fixtures (offline)", () => {
  it("accepts the checked-in v0_9 minimal surface", async () => {
    const messages = readFixture("v0_9-minimal-surface.json");
    const result = await validateA2uiMessages({ messages, protocolFamily: "v0_9" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.protocolFamily).toBe("v0_9");
      expect(Array.isArray(result.messages)).toBe(true);
    }
  });

  it("accepts the checked-in v1_0 minimal surface (reserved track)", async () => {
    const messages = readFixture("v1_0-minimal-surface.json");
    const result = await validateA2uiMessages({ messages, protocolFamily: "v1_0" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.protocolFamily).toBe("v1_0");
    }
  });

  it("rejects invalid messages", async () => {
    const messages = readFixture("invalid-message.json");
    const result = await validateA2uiMessages({ messages, protocolFamily: "v0_9" });
    expect(result.ok).toBe(false);
  });
});

describe("compileInteractionPlan", () => {
  const plan = {
    intent: "email.compose",
    title: "Draft reply",
    summary: "Reply to Alex",
    fields: [
      {
        name: "to",
        value: "alex@example.com",
        required: true,
        status: "resolved" as const,
      },
      {
        name: "body",
        required: true,
        status: "missing" as const,
      },
    ],
    nextStep: "render" as const,
    riskLevel: "medium" as const,
  };

  it("compiles to a schema-valid v0_9 message list", async () => {
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "interaction-surface-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.protocolFamily).toBe("v0_9");
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages[0]).toMatchObject({
      version: "v0.9",
      createSurface: { surfaceId: "interaction-surface-1" },
    });
  });

  it("can compile on the reserved v1_0 track", async () => {
    const result = await compileInteractionPlan({
      plan,
      surfaceId: "interaction-surface-v1",
      protocolFamily: "v1_0",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.protocolFamily).toBe("v1_0");
    expect(result.messages[0]).toMatchObject({
      version: "1.0",
      createSurface: { surfaceId: "interaction-surface-v1" },
    });
  });

  it("rejects an empty surfaceId", async () => {
    const result = await compileInteractionPlan({ plan, surfaceId: "  " });
    expect(result.ok).toBe(false);
  });
});
