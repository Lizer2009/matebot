import type { InteractionSurfaceSchema } from "@matebot/contracts";
import type { OpenSurface } from "@matebot/core";
import { describe, expect, it, vi } from "vitest";
import type { NaturalLanguageEditDeps } from "./interaction-nl-edit.js";
import { applyNaturalLanguageEdit } from "./interaction-nl-edit.js";

/**
 * The model proposes field values for an *existing* draft. This service must
 * update that draft, bump its revision, republish the same surface, and never
 * create a second card or trigger a send. These tests encode that.
 */

const schema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [
    { name: "to", label: "To", kind: "email", required: true },
    { name: "subject", label: "Subject", kind: "text", required: true },
    { name: "body", label: "Message", kind: "longText", required: false },
  ],
  action: { id: "send", label: "Send", requiresRevision: true },
};

type Row = {
  id: string;
  spaceId: string;
  threadId: string;
  intent: string;
  status: string;
  draftVersion: number;
  confirmedVersion: number | null;
  slots: Record<string, unknown>;
};

function deps(overrides: { row?: Partial<Row> | null; surfaces?: OpenSurface[] } = {}) {
  const row: Row | null =
    overrides.row === null
      ? null
      : {
          id: "ix-1",
          spaceId: "space-1",
          threadId: "thread-1",
          intent: "email.compose",
          status: "ready_for_review",
          draftVersion: 4,
          confirmedVersion: null,
          slots: { to: "a@example.com", subject: "Hi", body: "" },
          ...overrides.row,
        };
  return {
    loadInteraction: vi.fn(async (_interactionId: string) => row),
    listOpenSurfaces: vi.fn(
      async (_input: { spaceId: string; threadId: string }) =>
        overrides.surfaces ?? [
          {
            taskId: "ix-1",
            surfaceId: "surf-1",
            label: "Email to a@example.com",
            status: "draft" as const,
            intent: "email.compose",
          },
        ],
    ),
    applyField: vi.fn(
      async (_field: {
        spaceId: string;
        threadId: string;
        botId: string;
        interactionId: string;
        expectedDraftVersion: number;
        name: string;
        value: unknown;
      }) => ({ draftVersion: 5 }),
    ),
  } satisfies NaturalLanguageEditDeps;
}

const input = {
  spaceId: "space-1",
  threadId: "thread-1",
  interactionId: "ix-1",
  schema,
  fields: { subject: "秋后问候" },
  revision: 4,
};

describe("applyNaturalLanguageEdit", () => {
  it("updates the existing draft and republishes the same surface", async () => {
    const d = deps();
    const result = await applyNaturalLanguageEdit(d, input);
    expect(result).toMatchObject({ ok: true, draftVersion: 5, surfaceId: "surf-1" });
    expect(d.applyField).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: "ix-1",
        expectedDraftVersion: 4,
        name: "subject",
        value: "秋后问候",
      }),
    );
  });

  // The whole point: a prose edit is an edit, not a new card and not a send.
  it("never creates a second card and never sends", async () => {
    const d = deps();
    await applyNaturalLanguageEdit(d, input);
    // One write for the one field, through the same path the card uses.
    expect(d.applyField).toHaveBeenCalledTimes(1);
    // Nothing in the deps can send; assert the result does not claim a send.
    const result = await applyNaturalLanguageEdit(d, input);
    expect(result).not.toHaveProperty("sent");
    expect(result).not.toHaveProperty("providerMessageId");
  });

  it("refuses a stale revision instead of applying over newer edits", async () => {
    const d = deps({ row: { draftVersion: 6 } });
    expect(await applyNaturalLanguageEdit(d, input)).toMatchObject({
      ok: false,
      error: "stale_revision",
    });
    expect(d.applyField).not.toHaveBeenCalled();
  });

  it("refuses when the interaction belongs to another thread", async () => {
    const d = deps({ row: { threadId: "thread-2" } });
    expect(await applyNaturalLanguageEdit(d, input)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(d.applyField).not.toHaveBeenCalled();
  });

  it("refuses an unknown interaction", async () => {
    const d = deps({ row: null });
    expect(await applyNaturalLanguageEdit(d, input)).toMatchObject({
      ok: false,
      error: "unknown_interaction",
    });
  });

  // An executed card cannot be edited in place; the user needs a new draft.
  it("refuses to edit an executed card and says why", async () => {
    const d = deps({ row: { status: "succeeded" } });
    expect(await applyNaturalLanguageEdit(d, input)).toMatchObject({
      ok: false,
      error: "already_executed",
    });
    expect(d.applyField).not.toHaveBeenCalled();
  });

  // Editing an approved draft must revoke the approval, so the card is Send-able only after re-confirm.
  it("reports that a change to an approved payload revoked its approval", async () => {
    const d = deps({ row: { status: "awaiting_approval", confirmedVersion: 4 } });
    const result = await applyNaturalLanguageEdit(d, input);
    expect(result).toMatchObject({ ok: true, confirmationInvalidated: true });
  });

  // A field the user typed is theirs; a prose rewrite must not clobber it silently.
  it("does not silently overwrite a field the user already typed", async () => {
    const d = deps({ row: { slots: { to: "typed@example.com", subject: "Mine", body: "" } } });
    const result = await applyNaturalLanguageEdit(d, {
      ...input,
      fields: { subject: "Model rewrite", body: "New body" },
      userEditedFields: ["subject"],
    });
    expect(result).toMatchObject({ ok: true, skippedFields: ["subject"] });
    const names = d.applyField.mock.calls.map((call) => call[0].name);
    // The protected field is not written; the untouched one still is.
    expect(names).toEqual(["body"]);
  });

  it("asks which card when the reference is ambiguous across several cards", async () => {
    const d = deps({
      surfaces: [
        {
          taskId: "ix-1",
          surfaceId: "surf-1",
          label: "Email to a@example.com",
          status: "draft",
          intent: "email.compose",
        },
        {
          taskId: "ix-2",
          surfaceId: "surf-2",
          label: "Email to b@example.com",
          status: "draft",
          intent: "email.compose",
        },
      ],
    });
    const result = await applyNaturalLanguageEdit(d, { ...input, interactionId: undefined });
    expect(result).toMatchObject({ ok: false, error: "ambiguous_target" });
    expect(d.applyField).not.toHaveBeenCalled();
  });

  it("rejects a field the schema does not declare", async () => {
    const d = deps();
    expect(
      await applyNaturalLanguageEdit(d, { ...input, fields: { password: "hunter2" } }),
    ).toMatchObject({ ok: false, error: "unknown_field" });
    expect(d.applyField).not.toHaveBeenCalled();
  });

  it("refuses to collect a secret through a generated form", async () => {
    const d = deps();
    expect(
      await applyNaturalLanguageEdit(d, { ...input, fields: { apiKey: "sk-123" } }),
    ).toMatchObject({ ok: false, error: "unknown_field" });
  });
});
