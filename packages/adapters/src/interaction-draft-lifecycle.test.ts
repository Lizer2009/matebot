import type { InteractionPlan } from "@matebot/contracts";
import { MessageBlock as MessageBlockSchema } from "@matebot/contracts";
import {
  confirmInteractionDraftState,
  interactionSlotsFromPlan,
  requiredFieldsSatisfied,
} from "@matebot/core";
import { InteractionTerminalError } from "@matebot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateInteractionFieldService } from "./interaction-field-writer.js";
import { publishInteractionSurface } from "./interaction-publish.js";

/**
 * The chain the reader actually walks: publish a draft, edit a field, republish, then confirm.
 *
 * Compiling a reconciled view fixed the card on screen but not the row behind it. The
 * interaction stores the plan and the slots, and the confirm gate reads those by the schema's
 * field names — so a draft whose values sat under `To`/`Subject`/`Body` compiled into a form
 * that looked right and then refused to confirm with "Required fields are missing".
 *
 * These cases drive the production publish and field-writer entry points and then run the real
 * confirm gate over what was stored, which is the only way to see that class of split.
 */

const createInteraction = vi.fn();
const upsertInteractionSurface = vi.fn();
const createThreadMessageInTransaction = vi.fn();
const appendEventInTransaction = vi.fn();
const getInteraction = vi.fn();
const txInteractionUpdateMany = vi.fn();
const txMessageFindUnique = vi.fn();
const txMessageUpdate = vi.fn();
const messageFindUnique = vi.fn();
const surfaceFindFirst = vi.fn();

vi.mock("@matebot/db", async () => {
  const actual = await vi.importActual<typeof import("@matebot/db")>("@matebot/db");
  return {
    ...actual,
    createInteraction: (...args: unknown[]) => createInteraction(...args),
    upsertInteractionSurface: (...args: unknown[]) => upsertInteractionSurface(...args),
    createThreadMessageInTransaction: (...args: unknown[]) =>
      createThreadMessageInTransaction(...args),
    appendEventInTransaction: (...args: unknown[]) => appendEventInTransaction(...args),
    appendInteractionEvent: vi.fn(async () => undefined),
    getInteraction: (...args: unknown[]) => getInteraction(...args),
    withTransactionRetry: async (work: () => Promise<unknown>) => work(),
  };
});

const prisma = {
  $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
    work({
      interaction: {
        updateMany: txInteractionUpdateMany,
        update: vi.fn(async () => ({ id: "ix-1" })),
      },
      message: { findUnique: txMessageFindUnique, update: txMessageUpdate },
    }),
  interactionSurface: { findFirst: (...args: unknown[]) => surfaceFindFirst(...args) },
  message: { findUnique: (...args: unknown[]) => messageFindUnique(...args) },
} as never;

const emailPlan = (fields: InteractionPlan["fields"]): InteractionPlan => ({
  intent: "email.compose",
  title: "冬天的问候",
  fields,
  nextStep: "render",
  riskLevel: "medium",
});

/** What the publish path stored, read back the way the confirm gate would. */
function storedInteraction() {
  const input = createInteraction.mock.calls.at(-1)?.[1] as {
    plan: InteractionPlan;
    slots: Record<string, unknown>;
  };
  return { plan: input.plan, slots: input.slots };
}

beforeEach(() => {
  vi.clearAllMocks();
  createInteraction.mockResolvedValue({ id: "ix-1", draftVersion: 1 });
  upsertInteractionSurface.mockResolvedValue({ documentRef: "doc-1" });
  createThreadMessageInTransaction.mockResolvedValue({ id: "msg-1" });
  appendEventInTransaction.mockImplementation(async (_tx: unknown, event: { type: string }) =>
    event.type === "thread.surface.created" ? { seq: 7 } : { seq: 6 },
  );
  surfaceFindFirst.mockResolvedValue({
    surfaceId: "surface-1",
    protocolFamily: "v0_9",
  });
  messageFindUnique.mockResolvedValue({ blocks: [] });
  txMessageFindUnique.mockResolvedValue({ id: "msg-1", blocks: [] });
  txMessageUpdate.mockResolvedValue({ id: "msg-1" });
  txInteractionUpdateMany.mockResolvedValue({ count: 1 });
});

describe("publish stores the schema's field names", () => {
  it("normalises a plan that spelled the values in Title case", async () => {
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "To", value: "alex@example.test", required: true, status: "resolved" },
        { name: "Subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "Body", value: "正文", required: true, status: "resolved" },
      ]),
      capability: "ready",
    });

    const { plan, slots } = storedInteraction();
    expect(plan.fields.map((field) => field.name)).toContain("to");
    expect(plan.fields.map((field) => field.name)).not.toContain("To");
    expect(Object.keys(slots).sort()).toEqual(["body", "subject", "to"]);
  });

  it("leaves the stored draft confirmable", async () => {
    const published = await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "To", value: "alex@example.test", required: true, status: "resolved" },
        { name: "Subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "Body", value: "正文", required: true, status: "resolved" },
      ]),
      capability: "ready",
    });

    const { plan, slots } = storedInteraction();
    expect(published.missingRequired).toEqual([]);
    expect(requiredFieldsSatisfied(plan, slots)).toBe(true);
    const gate = confirmInteractionDraftState(
      { status: "collecting", draftVersion: 1, confirmedVersion: null, plan, slots },
      1,
    );
    expect(gate).toEqual({ ok: true, confirmedVersion: 1, status: "awaiting_approval" });
  });

  it("keeps an undeclared field as data while the declared ones become controls", async () => {
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
        { name: "attachments", value: ["a.pdf"], required: false, status: "resolved" },
      ]),
      capability: "ready",
    });
    const { plan, slots } = storedInteraction();
    // The undeclared field survives as data; the schema's three are what the form shows.
    expect(plan.fields.map((field) => field.name)).toContain("attachments");
    expect(slots.attachments).toEqual(["a.pdf"]);
    expect(requiredFieldsSatisfied(plan, slots)).toBe(true);
  });
});

describe("a field edit republishes in the schema's names", () => {
  function arrangeDraft(plan: InteractionPlan, slots: Record<string, unknown>, draftVersion = 1) {
    getInteraction.mockResolvedValue({
      id: "ix-1",
      threadId: "thread-1",
      status: "collecting",
      draftVersion,
      confirmedVersion: null,
      plan,
      slots,
      messageId: "msg-1",
    });
  }

  it("the reader filling an empty body makes the draft confirmable", async () => {
    // The state the publish path now stores when the model left the body out.
    arrangeDraft(
      emailPlan([
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "body", required: true, status: "missing" },
      ]),
      { to: "alex@example.test", subject: "冬天的问候" },
    );

    await updateInteractionFieldService(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 1,
      name: "body",
      value: "愿这个冬天顺遂。",
      origin: "user",
    });

    const data = txInteractionUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { plan: InteractionPlan; slots: Record<string, unknown>; draftVersion: number };
    };
    expect(data.data.draftVersion).toBe(2);
    expect(Object.keys(data.data.slots)).toContain("body");
    expect(requiredFieldsSatisfied(data.data.plan, data.data.slots)).toBe(true);
    // The person's own text is stamped as theirs.
    expect(data.data.plan.fields.find((field) => field.name === "body")?.source).toBe("user");
  });

  it("clears staleAt so a later settle does not close the card being edited", async () => {
    arrangeDraft(
      emailPlan([
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "body", required: true, status: "missing" },
      ]),
      { to: "alex@example.test", subject: "冬天的问候" },
    );

    await updateInteractionFieldService(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 1,
      name: "body",
      value: "愿这个冬天顺遂。",
      origin: "user",
    });

    const lastUpdate = txInteractionUpdateMany.mock.calls.at(-1)?.[0] as
      | { data: { staleAt?: Date | null } }
      | undefined;
    expect(lastUpdate?.data.staleAt).toBeNull();
  });

  it("an edit to a plan stored with two spellings still lands on the schema's name", async () => {
    // Rows written before the fix can still hold both spellings. An edit has to work on them.
    arrangeDraft(
      emailPlan([
        { name: "to", required: true, status: "missing" },
        { name: "subject", required: true, status: "missing" },
        { name: "body", required: true, status: "missing" },
        { name: "To", value: "alex@example.test", required: true, status: "resolved" },
        { name: "Subject", value: "s", required: true, status: "resolved" },
        { name: "Body", value: "b", required: true, status: "resolved" },
      ]),
      { To: "alex@example.test", Subject: "s", Body: "b" },
    );

    await updateInteractionFieldService(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 1,
      name: "to",
      value: "changed@example.test",
      origin: "user",
    });

    const data = txInteractionUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { plan: InteractionPlan; slots: Record<string, unknown> };
    };
    const names = data.data.plan.fields.map((field) => field.name);
    expect(names).toContain("to");
    expect(names).not.toContain("To");
    expect(data.data.slots.to).toBe("changed@example.test");
    expect(requiredFieldsSatisfied(data.data.plan, data.data.slots)).toBe(true);
  });

  it("keeps a calendar boolean editable without refusing the write", async () => {
    // The field writer used to compile every field as text. A boolean here must not turn an
    // ordinary edit into an error.
    arrangeDraft(
      {
        intent: "calendar.create",
        title: "Standup",
        fields: [
          { name: "name", value: "Standup", required: true, status: "resolved" },
          { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
          { name: "end", value: "2026-11-09T09:30:00+08:00", required: true, status: "resolved" },
          { name: "allDay", value: false, required: false, status: "resolved" },
        ],
        nextStep: "render",
        riskLevel: "medium",
      },
      {
        name: "Standup",
        start: "2026-11-09T09:00:00+08:00",
        end: "2026-11-09T09:30:00+08:00",
        allDay: false,
      },
    );

    await expect(
      updateInteractionFieldService(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        expectedDraftVersion: 1,
        name: "name",
        value: "Standup v2",
        origin: "user",
      }),
    ).resolves.toEqual({ draftVersion: 2 });
  });

  it("still refuses an edit against a stale revision", async () => {
    arrangeDraft(
      emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      { to: "a@example.test", subject: "s", body: "b" },
      3,
    );
    await expect(
      updateInteractionFieldService(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        expectedDraftVersion: 1,
        name: "subject",
        value: "new",
        origin: "user",
      }),
    ).rejects.toThrow();
    expect(txInteractionUpdateMany).not.toHaveBeenCalled();
  });
});

describe("slots and plan agree after a round trip", () => {
  it("every stored slot name is a field name", async () => {
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "TO", value: "a@example.test", required: true, status: "resolved" },
        { name: "SUBJECT", value: "s", required: true, status: "resolved" },
        { name: "BODY", value: "b", required: true, status: "resolved" },
        { name: "events", value: [1, 2], required: false, status: "resolved" },
      ]),
      capability: "ready",
    });
    const { plan, slots } = storedInteraction();
    const declared = new Set(plan.fields.map((field) => field.name));
    for (const name of Object.keys(slots)) expect(declared.has(name)).toBe(true);
    // And the recomputed slots from the stored plan match what was stored.
    expect(interactionSlotsFromPlan(plan)).toEqual(slots);
  });
});

describe("the row agrees with the card about what is missing", () => {
  it("stores the declared fields even when the plan listed none", async () => {
    // Otherwise the card draws four controls and says three are missing, while the stored row
    // has no fields at all — so the confirm gate passes a draft the card shows as empty.
    const published = await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([]),
      capability: "ready",
    });
    const { plan, slots } = storedInteraction();
    expect(plan.fields.map((field) => field.name)).toEqual(["to", "cc", "subject", "body"]);
    expect(published.missingRequired).toEqual(["to", "subject", "body"]);
    expect(requiredFieldsSatisfied(plan, slots)).toBe(false);
    const gate = confirmInteractionDraftState(
      { status: "collecting", draftVersion: 1, confirmedVersion: null, plan, slots },
      1,
    );
    expect(gate.ok).toBe(false);
  });

  it("takes required from the schema, not from the model's own flag", async () => {
    // A model that marks the recipient optional must not make an empty recipient confirmable.
    const published = await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "", required: false, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      capability: "ready",
    });
    const { plan, slots } = storedInteraction();
    expect(plan.fields.find((field) => field.name === "to")?.required).toBe(true);
    expect(published.missingRequired).toEqual(["to"]);
    expect(requiredFieldsSatisfied(plan, slots)).toBe(false);
  });

  it("never makes an undeclared field required, because nothing can fill it", async () => {
    // A required flag on a field with no control is a draft that can never be confirmed.
    const published = await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
        { name: "events", required: true, status: "missing" },
      ]),
      capability: "ready",
    });
    const { plan, slots } = storedInteraction();
    expect(plan.fields.find((field) => field.name === "events")?.required).toBe(false);
    expect(published.missingRequired).toEqual([]);
    expect(requiredFieldsSatisfied(plan, slots)).toBe(true);
  });

  it("reports the document it stored alongside the row", async () => {
    // The document and the row must agree; asserting only the row let them drift before.
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "To", value: "a@example.test", required: true, status: "resolved" },
        { name: "Subject", value: "s", required: true, status: "resolved" },
        { name: "Body", value: "b", required: true, status: "resolved" },
      ]),
      capability: "ready",
    });
    const stored = upsertInteractionSurface.mock.calls.at(-1)?.[1] as {
      document: Array<{ updateDataModel?: { value?: { values?: Record<string, unknown> } } }>;
    };
    const values = stored.document.find((message) => message.updateDataModel)?.updateDataModel
      ?.value?.values;
    const { slots } = storedInteraction();
    expect(values).toEqual(slots);
  });
});

describe("a field the person wrote is not shadowed by another spelling", () => {
  it("keeps the typed value when the other spelling comes first", async () => {
    // A row written before reconciliation can list `To` before `to`. Taking the first match
    // would store the old value and silently drop the keystroke.
    getInteraction.mockResolvedValue({
      id: "ix-1",
      threadId: "thread-1",
      status: "collecting",
      draftVersion: 1,
      confirmedVersion: null,
      plan: emailPlan([
        { name: "To", value: "old@example.test", required: true, status: "resolved" },
        { name: "to", value: "old@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      slots: { To: "old@example.test", subject: "s", body: "b" },
      messageId: "msg-1",
    });
    surfaceFindFirst.mockResolvedValue({ surfaceId: "surface-1", protocolFamily: "v0_9" });
    messageFindUnique.mockResolvedValue({ blocks: [] });
    txMessageFindUnique.mockResolvedValue({ id: "msg-1", blocks: [] });
    txMessageUpdate.mockResolvedValue({ id: "msg-1" });
    txInteractionUpdateMany.mockResolvedValue({ count: 1 });

    await updateInteractionFieldService(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 1,
      name: "to",
      value: "typed@example.test",
      origin: "user",
    });

    const data = txInteractionUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { plan: InteractionPlan; slots: Record<string, unknown> };
    };
    expect(data.data.slots.to).toBe("typed@example.test");
    expect(data.data.plan.fields.filter((field) => field.name === "to")).toHaveLength(1);
  });
});

describe("cancel always works", () => {
  it("cancels a draft whose stored values no longer compile", async () => {
    // The draft someone wants to get rid of is exactly the one whose values are broken. A
    // recompile failure must not leave it uncancellable.
    const { cancelInteractionService } = await import("./interaction-field-writer.js");
    getInteraction.mockResolvedValue({
      id: "ix-1",
      threadId: "thread-1",
      status: "collecting",
      draftVersion: 1,
      confirmedVersion: null,
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b".repeat(50_000), required: true, status: "resolved" },
      ]),
      slots: { to: "a@example.test", subject: "s" },
      messageId: "msg-1",
    });
    surfaceFindFirst.mockResolvedValue({ surfaceId: "surface-1", protocolFamily: "v0_9" });
    messageFindUnique.mockResolvedValue({ blocks: [] });
    txMessageFindUnique.mockResolvedValue({ id: "msg-1", blocks: [] });
    txMessageUpdate.mockResolvedValue({ id: "msg-1" });
    txInteractionUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      cancelInteractionService(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        interactionId: "ix-1",
        expectedDraftVersion: 1,
        runtimeCanAbort: false,
      }),
    ).resolves.toEqual({ status: "cancelled", draftVersion: 2 });

    const data = txInteractionUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { status: string };
    };
    expect(data.data.status).toBe("cancelled");
  });
});

describe("the label survives every rebuild of the card", () => {
  it("keeps the label when the card is cancelled", async () => {
    // A cancelled card still shows which mailbox it would have used. The cancel path rebuilds the
    // block from its new stamps, so without carrying the label over the row blanks at the moment
    // the person is deciding what to do next.
    const { cancelInteractionService } = await import("./interaction-field-writer.js");
    getInteraction.mockResolvedValue({
      id: "ix-1",
      threadId: "thread-1",
      status: "collecting",
      draftVersion: 1,
      confirmedVersion: null,
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      slots: { to: "a@example.test", subject: "s", body: "b" },
      messageId: "msg-1",
    });
    surfaceFindFirst.mockResolvedValue({ surfaceId: "surface-1", protocolFamily: "v0_9" });
    messageFindUnique.mockResolvedValue({ blocks: [] });
    txMessageFindUnique.mockResolvedValue({
      id: "msg-1",
      blocks: [
        {
          kind: "a2ui_surface",
          interactionId: "ix-1",
          surfaceId: "surface-1",
          draftVersion: 1,
          intent: "email.compose",
          capability: "ready",
          senderLabel: "Gmail",
        },
      ],
    });
    txMessageUpdate.mockResolvedValue({ id: "msg-1" });
    txInteractionUpdateMany.mockResolvedValue({ count: 1 });

    await cancelInteractionService(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 1,
      runtimeCanAbort: false,
    });

    const written = txMessageUpdate.mock.calls.at(-1)?.[0] as {
      data: { blocks: Array<Record<string, unknown>> };
    };
    expect(written.data.blocks[0]).toMatchObject({
      senderLabel: "Gmail",
      lifecycle: "draft",
    });
  });
});

describe("the card carries the connection's label, never an address", () => {
  it("writes the label onto the block and leaves the address out", async () => {
    // `Connection.displayName` is whatever the client passed when the connection was created —
    // a card title, an app name — so it is a label. Presenting it as the sending address would
    // be a claim the server cannot support.
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      capability: "ready",
      senderLabel: "Gmail",
    });
    const block = createThreadMessageInTransaction.mock.calls.at(-1)?.[1] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(block.blocks[0]).toMatchObject({ senderLabel: "Gmail" });
    // Nothing on the block claims to be the address.
    expect(Object.keys(block.blocks[0] ?? {})).not.toContain("senderAddress");
    expect(Object.keys(block.blocks[0] ?? {})).not.toContain("from");
  });

  it("writes a provider mailbox only when the publisher was given one", async () => {
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      capability: "ready",
      senderLabel: "Gmail",
      senderAddress: "lizer@example.test",
    });
    const block = createThreadMessageInTransaction.mock.calls.at(-1)?.[1] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(block.blocks[0]).toMatchObject({
      senderLabel: "Gmail",
      senderAddress: "lizer@example.test",
    });
  });

  it("omits the label when no connection named one", async () => {
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      capability: "not_connected",
    });
    const block = createThreadMessageInTransaction.mock.calls.at(-1)?.[1] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(block.blocks[0]).not.toHaveProperty("senderLabel");
  });

  it("drops a label too long for a block instead of storing one that cannot be read", async () => {
    // The connection row takes any label, and this one is often a title the model wrote. A block
    // holding it verbatim would fail to parse on the way out and take the whole card with it.
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      capability: "ready",
      senderLabel: "很长".repeat(60),
    });
    const block = createThreadMessageInTransaction.mock.calls.at(-1)?.[1] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(block.blocks[0]).not.toHaveProperty("senderLabel");
    // The card itself is still a valid block, so the draft does not disappear with the label.
    expect(MessageBlockSchema.safeParse(block.blocks[0]).success).toBe(true);
  });
});

describe("the sender row survives a rebuild", () => {
  it("keeps the connection's label when a field edit republishes the card", async () => {
    // An edit rebuilds the block. A rebuild that dropped the label would blank the card's
    // read-only sender row after the first keystroke.
    messageFindUnique.mockResolvedValue({
      blocks: [
        {
          kind: "a2ui_surface",
          surfaceId: "surface-1",
          senderLabel: "Gmail",
          senderAddress: "lizer@example.test",
        },
      ],
    });
    txMessageFindUnique.mockResolvedValue({
      id: "msg-1",
      blocks: [
        {
          kind: "a2ui_surface",
          surfaceId: "surface-1",
          senderLabel: "Gmail",
          senderAddress: "lizer@example.test",
        },
      ],
    });
    getInteraction.mockResolvedValue({
      id: "ix-1",
      threadId: "thread-1",
      status: "collecting",
      draftVersion: 1,
      confirmedVersion: null,
      plan: emailPlan([
        { name: "to", value: "a@example.test", required: true, status: "resolved" },
        { name: "subject", value: "s", required: true, status: "resolved" },
        { name: "body", value: "b", required: true, status: "resolved" },
      ]),
      slots: { to: "a@example.test", subject: "s", body: "b" },
      messageId: "msg-1",
    });
    surfaceFindFirst.mockResolvedValue({ surfaceId: "surface-1", protocolFamily: "v0_9" });
    txInteractionUpdateMany.mockResolvedValue({ count: 1 });

    await updateInteractionFieldService(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      interactionId: "ix-1",
      expectedDraftVersion: 1,
      name: "subject",
      value: "新主题",
      origin: "user",
    });

    const update = txMessageUpdate.mock.calls.at(-1)?.[0] as {
      data: { blocks: Array<Record<string, unknown>> };
    };
    expect(update.data.blocks[0]).toMatchObject({
      senderLabel: "Gmail",
      senderAddress: "lizer@example.test",
    });
  });
});

describe("a field edit on a card that closed", () => {
  // A card can be superseded between the moment a client listed it and the moment
  // the person's keystroke arrives. That is a lost race, not a server fault: the
  // row must not be written, and the caller has to be able to answer as a conflict.
  it.each(["superseded", "expired", "sent", "executed", "confirmed", "cancelled"])(
    "refuses a %s row with a typed error and writes nothing",
    async (status) => {
      getInteraction.mockResolvedValue({
        id: "ix-1",
        threadId: "thread-1",
        status,
        draftVersion: 3,
        confirmedVersion: 3,
        plan: emailPlan([
          { name: "to", value: "alex@example.test", required: true, status: "resolved" },
          { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
          { name: "body", value: "正文", required: true, status: "resolved" },
        ]),
        slots: { to: "alex@example.test", subject: "冬天的问候", body: "正文" },
        messageId: "msg-1",
      });

      await expect(
        updateInteractionFieldService(prisma, {
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          interactionId: "ix-1",
          expectedDraftVersion: 3,
          name: "subject",
          value: "新主题",
          origin: "user",
        }),
      ).rejects.toBeInstanceOf(InteractionTerminalError);

      expect(txInteractionUpdateMany).not.toHaveBeenCalled();
      expect(txMessageUpdate).not.toHaveBeenCalled();
    },
  );
});
