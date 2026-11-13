import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalIntent,
  cardKindForIntent,
  findInteractionCapability,
  INTERACTION_CAPABILITIES,
  interactionCapabilityForIntent,
  interactionIntents,
  isActionIntent,
  isCalendarCreateIntent,
  isEmailComposeIntent,
} from "./interaction-capability.js";

/**
 * L1 of the architecture: the server owns which intents exist, what fields they
 * take, which connection they need, and whether they have an effect. The model
 * proposes; this decides. A model naming an unregistered intent gets a safe
 * fallback, never an executable surface.
 */

describe("capability registry", () => {
  it("registers the email capability with a send action and a mailbox connection", () => {
    const email = findInteractionCapability("email.compose");
    expect(email).toMatchObject({
      intent: "email.compose",
      effectKind: "email.send",
      requiresConnection: "email",
    });
    expect(email?.schema.action?.id).toBe("send");
    expect(email?.schema.presentation).toBe("form");
    expect(email?.historyDigestFields).toEqual(["to", "subject"]);
    // A secret must never be collected through a generated form.
    expect(email?.schema.fields.some((field) => /secret|password|token/i.test(field.name))).toBe(
      false,
    );
  });

  // Phase 1: calendar create is a real form with a real submit on the shared
  // pipeline, and it never collects attendees, so a create cannot invite anyone.
  it("registers calendar create as an implemented form with a create action", () => {
    const calendar = findInteractionCapability("calendar.create");
    expect(calendar).toMatchObject({
      requiresConnection: "calendar",
      effectKind: "calendar.create",
      implemented: true,
    });
    expect(calendar?.schema.presentation).toBe("form");
    expect(calendar?.schema.action).toMatchObject({ id: "create" });
    expect(calendar?.schema.fields.map((field) => field.name)).toEqual([
      "name",
      "start",
      "end",
      "timezone",
      "allDay",
    ]);
    expect(calendar?.historyDigestFields).toEqual(["name", "start", "end"]);
    // No attendee field exists, so no create can invite anyone.
    expect(calendar?.schema.fields.some((field) => /attendee|guest|invite/i.test(field.name))).toBe(
      false,
    );
  });

  // Reading a schedule must be a result, not a draft: "next week" is a query.
  it("registers calendar query as a read-only result with no action", () => {
    const query = findInteractionCapability("calendar.query");
    expect(query).toMatchObject({ readOnly: true, effectKind: null, implemented: true });
    expect(query?.schema.presentation).toBe("result");
    expect(query?.schema.action).toBeNull();
  });

  it("returns nothing for an unregistered intent, so callers can fall back", () => {
    expect(findInteractionCapability("github.clone")).toBeUndefined();
    expect(findInteractionCapability("sales.annualTrend")).toBeUndefined();
    expect(findInteractionCapability("test.form")).toBeUndefined();
    expect(interactionCapabilityForIntent("github.clone")).toBeUndefined();
  });

  it("exposes the registered intents for the prompt and docs to stay in sync", () => {
    expect(interactionIntents()).toEqual(
      expect.arrayContaining(["email.compose", "calendar.create"]),
    );
  });

  it("exposes exactly the four product intents", () => {
    expect(interactionIntents().sort()).toEqual(
      ["calendar.create", "calendar.query", "email.compose", "interaction.result"].sort(),
    );
  });

  it("keeps every registered capability internally consistent", () => {
    for (const capability of INTERACTION_CAPABILITIES) {
      // A form needs fields and exactly one action; a result has neither.
      if (capability.schema.presentation === "form") {
        expect(capability.schema.fields.length).toBeGreaterThan(0);
      }
      if (capability.schema.presentation === "form") {
        expect(capability.schema.action).not.toBeNull();
      } else {
        expect(capability.schema.action).toBeNull();
      }
      // Read-only capabilities must not claim an effect.
      if (capability.readOnly) expect(capability.effectKind).toBeNull();
      // An unimplemented capability must not offer a clickable action.
      if (!capability.implemented) expect(capability.schema.action).toBeNull();
    }
  });

  // The registry and the compiler's allowlist must agree, or a registered
  // capability would compile to a refusal (or worse, an unlisted action).
  it("declares only actions the compiler will accept", async () => {
    const { INTERACTION_ALLOWED_ACTIONS } = await import("@matebot/a2ui-adapter");
    const allowed = new Set<string>(INTERACTION_ALLOWED_ACTIONS);
    for (const capability of INTERACTION_CAPABILITIES) {
      if (!capability.schema.action) continue;
      expect(allowed.has(capability.schema.action.id)).toBe(true);
    }
  });

  it("declares no capability that needs a connection only because it is remote-by-habit", () => {
    // A local read-only analysis must be usable with no remote connection.
    const local = INTERACTION_CAPABILITIES.filter((capability) => capability.readOnly);
    for (const capability of local) {
      expect(capability.requiresConnection === null || capability.readOnly).toBe(true);
    }
  });

  it("classifies action vs result card kinds", () => {
    expect(cardKindForIntent("email.compose")).toBe("action");
    expect(cardKindForIntent("email.send")).toBe("action");
    expect(cardKindForIntent("calendar.create")).toBe("action");
    expect(cardKindForIntent("calendar.compose")).toBe("action");
    expect(cardKindForIntent("interaction.result")).toBe("result");
    expect(cardKindForIntent("calendar.query")).toBe("result");
    expect(cardKindForIntent("github.clone")).toBeUndefined();
    expect(isActionIntent("email.compose")).toBe(true);
    expect(isActionIntent("interaction.result")).toBe(false);
    expect(isActionIntent(undefined)).toBe(false);
  });

  it("canonicalizes aliases onto registered intents", () => {
    expect(canonicalIntent("email.send")).toBe("email.compose");
    expect(canonicalIntent("calendar.compose")).toBe("calendar.create");
    expect(canonicalIntent("email.compose")).toBe("email.compose");
    expect(findInteractionCapability(canonicalIntent("email.send"))?.intent).toBe("email.compose");
    expect(isEmailComposeIntent("email.send")).toBe(true);
    expect(isEmailComposeIntent("calendar.create")).toBe(false);
    expect(isCalendarCreateIntent("calendar.compose")).toBe(true);
    expect(isCalendarCreateIntent("email.compose")).toBe(false);
  });

  it("keeps cardKind aligned with the schema presentation", () => {
    for (const capability of INTERACTION_CAPABILITIES) {
      if (capability.cardKind === "action") {
        expect(capability.schema.presentation).toBe("form");
        expect(capability.schema.action).not.toBeNull();
      } else {
        expect(capability.cardKind).toBe("result");
        expect(capability.schema.presentation).toBe("result");
        expect(capability.schema.action).toBeNull();
      }
    }
  });

  it("does not special-case product intents outside the registry module", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const roots = [
      "packages/core/src",
      "packages/adapters/src",
      "packages/a2ui-adapter/src",
      "apps/api/src",
      "apps/web/src",
      "apps/mobile",
    ];
    const allow = new Set([
      "packages/core/src/interaction-capability.ts",
      "packages/core/src/interaction-capability.test.ts",
    ]);
    const classify = /(?<!\.kind\s*)(?<!\.kind\?)(?:===|!==)\s*"(?:email\.(?:compose|send)|calendar\.(?:create|compose|query)|interaction\.result)"/;
    const localSet =
      /(?:new\s+Set\([^)]*(?:email\.(?:compose|send)|calendar\.(?:create|compose))|FORM_INTENTS|EMAIL_NATIVE_INTENTS|CALENDAR_INTENTS)/;
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of listSourceFiles(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        if (allow.has(rel) || /\.test\.(ts|tsx)$/.test(rel) || /\/e2e\//.test(rel)) continue;
        const source = readFileSync(file, "utf8");
        for (const [index, line] of source.split("\n").entries()) {
          if (classify.test(line) || localSet.test(line)) {
            hits.push(`${rel}:${index + 1}:${line.trim()}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...listSourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}
