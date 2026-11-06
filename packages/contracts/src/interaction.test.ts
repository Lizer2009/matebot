import { describe, expect, it } from "vitest";
import { MessageBlock, ProductEventSchema, ProductEventType } from "./events.js";
import {
  A2uiProtocolFamily,
  A2uiSurfaceBlockSchema,
  a2uiSurfaceDocumentRef,
  InteractionFieldStatus,
  InteractionNextStep,
  InteractionPlanSchema,
  InteractionProductEventPayloadSchema,
  InteractionRiskLevel,
  parseA2uiSurfaceDocumentRef,
  SurfaceProductEventPayloadSchema,
  ThreadsConfirmInteractionInput,
  ThreadsConfirmInteractionOutput,
  ThreadsGetA2uiSurfaceInput,
  ThreadsGetA2uiSurfaceOutput,
  ThreadsUpdateInteractionFieldInput,
  ThreadsUpdateInteractionFieldOutput,
} from "./interaction.js";

describe("InteractionPlanSchema", () => {
  const base = {
    intent: "email.compose",
    title: "Send email",
    fields: [
      {
        name: "to",
        value: "alex@example.com",
        required: true,
        status: "resolved" as const,
        source: "thread",
        confidence: 0.9,
      },
      { name: "subject", required: true, status: "missing" as const },
    ],
    nextStep: "ask" as const,
    riskLevel: "medium" as const,
  };

  it("accepts a minimal plan and optional summary", () => {
    expect(InteractionPlanSchema.parse(base)).toMatchObject(base);
    expect(InteractionPlanSchema.parse({ ...base, summary: "Draft a reply" }).summary).toBe(
      "Draft a reply",
    );
  });

  it("rejects unknown nextStep, riskLevel, and field status values", () => {
    expect(InteractionPlanSchema.safeParse({ ...base, nextStep: "wing_it" }).success).toBe(false);
    expect(InteractionPlanSchema.safeParse({ ...base, riskLevel: "critical" }).success).toBe(false);
    expect(
      InteractionPlanSchema.safeParse({
        ...base,
        fields: [{ name: "to", required: true, status: "guessed" }],
      }).success,
    ).toBe(false);
  });

  it("exposes the locked enum members for adapters", () => {
    expect(InteractionFieldStatus.options).toEqual([
      "resolved",
      "missing",
      "needs_confirmation",
      "invalid",
    ]);
    expect(InteractionNextStep.options).toEqual([
      "render",
      "ask",
      "request_connection",
      "request_approval",
      "execute",
      "complete",
    ]);
    expect(InteractionRiskLevel.options).toEqual(["low", "medium", "high"]);
    expect(A2uiProtocolFamily.options).toEqual(["v0_9", "v1_0"]);
  });
});

describe("a2ui_surface MessageBlock", () => {
  const surface = {
    kind: "a2ui_surface" as const,
    interactionId: "ix-1",
    surfaceId: "surf-email-1",
    protocolFamily: "v0_9" as const,
    draftVersion: 1,
    title: "Email draft",
    summary: "To Alex · missing subject",
  };

  it("joins the MessageBlock discriminated union", () => {
    expect(MessageBlock.parse(surface)).toEqual(surface);
    expect(A2uiSurfaceBlockSchema.parse(surface)).toEqual(surface);
  });

  it("keeps existing block kinds valid", () => {
    expect(MessageBlock.parse({ kind: "text", text: "hi" })).toEqual({ kind: "text", text: "hi" });
    expect(MessageBlock.parse({ kind: "page", pageId: "p1", version: 1, title: "Notes" })).toEqual({
      kind: "page",
      pageId: "p1",
      version: 1,
      title: "Notes",
    });
  });

  it("requires interactionId, surfaceId, protocolFamily, and draftVersion", () => {
    expect(MessageBlock.safeParse({ kind: "a2ui_surface" }).success).toBe(false);
    expect(
      MessageBlock.safeParse({ ...surface, protocolFamily: "v0_8", draftVersion: 0 }).success,
    ).toBe(false);
  });
});

describe("interaction ProductEvent types", () => {
  const lifecycleTypes = [
    "thread.interaction.created",
    "thread.interaction.updated",
    "thread.surface.created",
    "thread.surface.updated",
    "thread.interaction.field_changed",
    "thread.interaction.approval_requested",
    "thread.interaction.action_started",
    "thread.interaction.action_progress",
    "thread.interaction.action_succeeded",
    "thread.interaction.action_failed",
  ] as const;

  it("extends ProductEventType without removing existing members", () => {
    for (const type of lifecycleTypes) {
      expect(ProductEventType.options).toContain(type);
    }
    expect(ProductEventType.options).toContain("thread.message.created");
    expect(ProductEventType.options).toContain("thread.ask");
    expect(ProductEventType.options).toContain("heartbeat");
  });

  it("parses ProductEvent envelopes for interaction and surface payloads", () => {
    const interactionPayload = InteractionProductEventPayloadSchema.parse({
      interactionId: "ix-1",
      intent: "email.compose",
      draftVersion: 2,
      title: "Send email",
    });
    const surfacePayload = SurfaceProductEventPayloadSchema.parse({
      interactionId: "ix-1",
      surfaceId: "surf-1",
      protocolFamily: "v1_0",
      draftVersion: 2,
      summary: "Ready to review",
    });

    expect(
      ProductEventSchema.parse({
        id: "ev-1",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 3,
        type: "thread.interaction.created",
        createdAt: "2026-11-06T00:00:00.000Z",
        payload: interactionPayload,
      }).type,
    ).toBe("thread.interaction.created");

    expect(
      ProductEventSchema.parse({
        id: "ev-2",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 4,
        type: "thread.surface.updated",
        createdAt: "2026-11-06T00:00:01.000Z",
        payload: surfacePayload,
      }).payload,
    ).toMatchObject(surfacePayload);
  });
});

describe("threads interaction RPC draft schemas", () => {
  it("validates field change with expected draftVersion", () => {
    const input = ThreadsUpdateInteractionFieldInput.parse({
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 3,
      name: "subject",
      value: "Hello",
    });
    expect(input).toMatchObject({
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 3,
      name: "subject",
      value: "Hello",
    });
    expect(ThreadsUpdateInteractionFieldOutput.parse({ ok: true, draftVersion: 4 })).toEqual({
      ok: true,
      draftVersion: 4,
    });
  });

  it("validates confirm with draftVersion becoming confirmedVersion", () => {
    expect(
      ThreadsConfirmInteractionInput.parse({
        groupId: "group-1",
        interactionId: "ix-1",
        draftVersion: 4,
      }),
    ).toMatchObject({ groupId: "group-1", draftVersion: 4 });
    expect(ThreadsConfirmInteractionOutput.parse({ ok: true, confirmedVersion: 4 })).toEqual({
      ok: true,
      confirmedVersion: 4,
    });
  });

  it("requires exactly one of botId or groupId", () => {
    expect(
      ThreadsUpdateInteractionFieldInput.safeParse({
        interactionId: "ix-1",
        expectedDraftVersion: 1,
        name: "to",
        value: "a@example.com",
      }).success,
    ).toBe(false);
    expect(
      ThreadsConfirmInteractionInput.safeParse({
        botId: "bot-1",
        groupId: "group-1",
        interactionId: "ix-1",
        draftVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("validates getA2uiSurface input/output", () => {
    expect(
      ThreadsGetA2uiSurfaceInput.parse({
        botId: "bot-1",
        documentRef: a2uiSurfaceDocumentRef({ interactionId: "ix-1", surfaceId: "surf-1" }),
      }).documentRef,
    ).toContain("a2ui:interaction:");
    expect(
      ThreadsGetA2uiSurfaceOutput.parse({
        interactionId: "ix-1",
        surfaceId: "surf-1",
        protocolFamily: "v0_9",
        draftVersion: 1,
        messages: [{ version: "v0.9" }],
        documentRef: a2uiSurfaceDocumentRef({ interactionId: "ix-1", surfaceId: "surf-1" }),
      }).messages,
    ).toHaveLength(1);
  });
});

describe("a2uiSurfaceDocumentRef", () => {
  it("round-trips interaction and surface ids", () => {
    const ref = a2uiSurfaceDocumentRef({ interactionId: "ix-42", surfaceId: "email-draft" });
    expect(parseA2uiSurfaceDocumentRef(ref)).toEqual({
      interactionId: "ix-42",
      surfaceId: "email-draft",
    });
  });

  it("rejects fixtures and malformed refs", () => {
    expect(parseA2uiSurfaceDocumentRef("fixture:v0_9-minimal")).toBeNull();
    expect(parseA2uiSurfaceDocumentRef("a2ui:interaction:only-id")).toBeNull();
  });
});
