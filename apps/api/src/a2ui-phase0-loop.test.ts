import type { InteractionSurfaceSchema } from "@matebot/contracts";
import type { NaturalLanguageEditDeps, SurfaceRevisionState } from "@matebot/core";
import { applyNaturalLanguageEdit, applySurfaceEdit, canSubmitSurface } from "@matebot/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dispatchInteractionActionService,
  resetInteractionDispatchState,
} from "./interaction-dispatch.js";
import { confirmThenExecute } from "./interaction-run-action.js";

/**
 * The full Phase 0 loop, with the pieces wired to each other rather than each
 * tested alone:
 *
 *   model proposes a field edit -> the same draft is rewritten and republished
 *   -> the user confirms the new revision -> one primary Send runs the effect
 *   exactly once, through a fake sender.
 *
 * No network, no provider, no OAuth. The "provider" is a counter, so "exactly
 * once" is an assertion rather than a claim.
 */

const schema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true },
    { name: "subject", label: "Subject", kind: "text", required: true },
    { name: "body", label: "Message", kind: "longText", required: true },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

/** The one draft, mutated in place by the services, as the row would be. */
type Draft = {
  id: string;
  spaceId: string;
  threadId: string;
  intent: string;
  status: string;
  draftVersion: number;
  confirmedVersion: number | null;
  values: Record<string, unknown>;
};

function scenario(draft: Partial<Draft> = {}) {
  const row: Draft = {
    id: "ix-1",
    spaceId: "space-1",
    threadId: "thread-1",
    intent: "email.compose",
    status: "ready_for_review",
    draftVersion: 2,
    confirmedVersion: null,
    values: { to: "a@example.com", subject: "Hi", body: "Hello" },
    ...draft,
  };
  /** Every republish of the surface, to prove it stayed one card. */
  const publishes: Array<{ surfaceId: string; draftVersion: number }> = [];
  /** The fake provider: counts how many times a send was attempted. */
  const sends: Array<Record<string, unknown>> = [];
  /** Effects created, so idempotency is observable. */
  const effects = new Map<string, { idempotencyKey: string; status: string }>();

  const schemaVersion = { value: 0 };

  const nlDeps: NaturalLanguageEditDeps = {
    loadInteraction: async () => ({
      id: row.id,
      spaceId: row.spaceId,
      threadId: row.threadId,
      intent: row.intent,
      status: row.status,
      draftVersion: row.draftVersion,
      confirmedVersion: row.confirmedVersion,
      slots: row.values,
    }),
    listOpenSurfaces: async () => [
      {
        taskId: row.id,
        surfaceId: "surf-1",
        label: "Email to a@example.com",
        status: "draft" as const,
        intent: "email.compose",
      },
    ],
    applyField: async (input: { expectedDraftVersion: number; name: string; value: unknown }) => {
      expect(input.expectedDraftVersion).toBe(row.draftVersion);
      row.values = { ...row.values, [input.name]: input.value };
      row.draftVersion += 1;
      row.confirmedVersion = null;
      row.status = "ready_for_review";
      schemaVersion.value += 1;
      publishes.push({ surfaceId: "surf-1", draftVersion: row.draftVersion });
      return { draftVersion: row.draftVersion };
    },
  };

  const dispatchDeps = {
    loadInteraction: async () => ({
      id: row.id,
      spaceId: row.spaceId,
      threadId: row.threadId,
      intent: row.intent,
      status:
        row.status === "succeeded"
          ? ("executed" as const)
          : row.confirmedVersion === row.draftVersion
            ? ("approved" as const)
            : ("draft" as const),
      draftVersion: row.draftVersion,
      confirmedVersion: row.confirmedVersion,
      schema,
    }),
    loadSurface: async () => ({ surfaceId: "surf-1" }),
    runAction: async ({ revision }: { revision: number }) =>
      confirmThenExecute(
        {
          confirm: async (input) => {
            // Confirming binds the exact revision the click carried.
            expect(input.draftVersion).toBe(revision);
            row.confirmedVersion = revision;
            row.status = "awaiting_approval";
            const key = `a2ui:interaction:${row.id}:confirm:${revision}`;
            const existing = effects.get(key);
            if (existing) {
              return { confirmedVersion: revision, effectId: "e-1", idempotencyKey: key };
            }
            effects.set(key, { idempotencyKey: key, status: "intended" });
            return { confirmedVersion: revision, effectId: "e-1", idempotencyKey: key };
          },
          execute: async () => {
            // The fake sender runs once per accepted effect.
            sends.push({ ...row.values });
            row.status = "succeeded";
            const key = `a2ui:interaction:${row.id}:confirm:${row.draftVersion}`;
            const effect = effects.get(key);
            if (effect) effect.status = "completed";
            return { effectId: "e-1", idempotencyKey: key, duplicate: false, executed: true };
          },
        },
        {
          spaceId: row.spaceId,
          threadId: row.threadId,
          botId: "bot-1",
          interactionId: row.id,
          revision,
          userId: "user-1",
          kind: "email.send",
        },
      ),
  };

  return { row, publishes, sends, effects, nlDeps, dispatchDeps, schemaVersion };
}

beforeEach(() => {
  resetInteractionDispatchState();
});

describe("model edit through confirm to exactly one send", () => {
  it("writes the model's field, republishes one surface, and sends once", async () => {
    const s = scenario();

    // 1. The model proposes a subject change against revision 2.
    const edited = await applyNaturalLanguageEdit(s.nlDeps, {
      spaceId: s.row.spaceId,
      threadId: s.row.threadId,
      interactionId: s.row.id,
      schema,
      fields: { subject: "秋后问候" },
      revision: 2,
    });
    expect(edited).toMatchObject({ ok: true, draftVersion: 3, surfaceId: "surf-1" });
    expect(s.row.values.subject).toBe("秋后问候");
    // One surface, moved forward — not a second card.
    expect(s.publishes).toEqual([{ surfaceId: "surf-1", draftVersion: 3 }]);

    // 2. The user confirms the new revision and presses the one Send.
    const dispatched = await dispatchInteractionActionService(s.dispatchDeps, {
      spaceId: s.row.spaceId,
      threadId: s.row.threadId,
      interactionId: s.row.id,
      surfaceId: "surf-1",
      action: "send",
      revision: 3,
    });
    expect(dispatched).toMatchObject({ ok: true, duplicate: false, revision: 3 });

    // 3. The fake provider saw exactly one send, carrying the edited value.
    expect(s.sends).toHaveLength(1);
    expect(s.sends[0]?.subject).toBe("秋后问候");
  });

  it("does not send twice when the button is pressed again", async () => {
    const s = scenario({ status: "awaiting_approval", confirmedVersion: 2 });
    const click = {
      spaceId: s.row.spaceId,
      threadId: s.row.threadId,
      interactionId: s.row.id,
      surfaceId: "surf-1",
      action: "send",
      revision: 2,
    };
    await dispatchInteractionActionService(s.dispatchDeps, click);
    await dispatchInteractionActionService(s.dispatchDeps, click);
    expect(s.sends).toHaveLength(1);
  });

  it("refuses a click from the pre-edit revision after the model changed the draft", async () => {
    const s = scenario();
    await applyNaturalLanguageEdit(s.nlDeps, {
      spaceId: s.row.spaceId,
      threadId: s.row.threadId,
      interactionId: s.row.id,
      schema,
      fields: { subject: "changed" },
      revision: 2,
    });
    // A stale surface still showing revision 2 must not send the new payload.
    const stale = await dispatchInteractionActionService(s.dispatchDeps, {
      spaceId: s.row.spaceId,
      threadId: s.row.threadId,
      interactionId: s.row.id,
      surfaceId: "surf-1",
      action: "send",
      revision: 2,
    });
    expect(stale).toMatchObject({ ok: false });
    expect(s.sends).toHaveLength(0);
  });

  it("invalidates the approval when the model changes an approved payload", async () => {
    const s = scenario({ status: "awaiting_approval", confirmedVersion: 2 });
    const edited = await applyNaturalLanguageEdit(s.nlDeps, {
      spaceId: s.row.spaceId,
      threadId: s.row.threadId,
      interactionId: s.row.id,
      schema,
      fields: { body: "new body" },
      revision: 2,
    });
    expect(edited).toMatchObject({ ok: true, confirmationInvalidated: true });
    // The approval is gone, so the old revision cannot send.
    const blocked = await dispatchInteractionActionService(s.dispatchDeps, {
      spaceId: s.row.spaceId,
      threadId: s.row.threadId,
      interactionId: s.row.id,
      surfaceId: "surf-1",
      action: "send",
      revision: 2,
    });
    expect(blocked).toMatchObject({ ok: false });
    expect(s.sends).toHaveLength(0);
  });
});

describe("revision rules applied to the same draft", () => {
  it("drops a replayed server event instead of rewinding the card", () => {
    const state: SurfaceRevisionState = {
      taskId: "ix-1",
      surfaceId: "surf-1",
      revision: 4,
      status: "draft",
      values: { subject: "current" },
      editedFields: ["subject"],
    };
    expect(
      applySurfaceEdit(state, { name: "subject", value: "stale", origin: "model" }).values.subject,
    ).toBe("current");
  });

  it("refuses a submit whose revision no longer matches the draft", () => {
    const state: SurfaceRevisionState = {
      taskId: "ix-1",
      surfaceId: "surf-1",
      revision: 5,
      status: "approved",
      values: {},
      editedFields: [],
    };
    expect(canSubmitSurface({ state, submittedRevision: 4 })).toEqual({
      ok: false,
      error: "stale_revision",
    });
  });

  it("keeps the surface schema the compiler would accept", async () => {
    // Compile the schema the loop used, so a malformed literal fails here.
    const { compileInteractionSurface } = await import("@matebot/a2ui-adapter");
    const compiled = await compileInteractionSurface({
      schema,
      values: { to: "a@example.com", subject: "Hi", body: "Hello" },
      surfaceId: "surf-1",
      interactionId: "ix-1",
      revision: 2,
    });
    expect(compiled.ok).toBe(true);
  });
});
