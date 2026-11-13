import type { InteractionPlan } from "@matebot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishInteractionSurface } from "./interaction-publish.js";

/**
 * What an email draft actually compiles to, through the production publish path.
 *
 * The 2026-11-09 thread has a card whose stored document was one Column and three Text nodes
 * with no input in it, while the reader was told the recipient, subject and body were filled
 * in. Two things had to be true for that: the compiler produced a caption, and the publish
 * reported success anyway.
 *
 * These cases drive `publishInteractionSurface` — the same call `present_interaction` makes,
 * with the capability's own schema — and read the document it stores.
 */

const createInteraction = vi.fn();
const upsertInteractionSurface = vi.fn();
const createThreadMessageInTransaction = vi.fn();
const appendEventInTransaction = vi.fn();

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
    withTransactionRetry: async (work: () => Promise<unknown>) => work(),
  };
});

const prisma = {
  $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
    work({ interaction: { update: vi.fn(async () => ({ id: "ix-1" })) } }),
} as never;

const emailPlan = (fields: InteractionPlan["fields"]): InteractionPlan => ({
  intent: "email.compose",
  title: "冬天的问候",
  fields,
  nextStep: "render",
  riskLevel: "medium",
});

function storedDocument(): Array<Record<string, unknown>> {
  const input = upsertInteractionSurface.mock.calls.at(-1)?.[1] as { document: unknown[] };
  return input.document as Array<Record<string, unknown>>;
}

function componentKinds(): string[] {
  const kinds: string[] = [];
  for (const message of storedDocument()) {
    const components = (message.updateComponents as { components?: unknown[] } | undefined)
      ?.components;
    for (const component of components ?? []) {
      const kind = (component as { component?: string })?.component;
      if (typeof kind === "string") kinds.push(kind);
    }
  }
  return kinds;
}

function storedValues(): Record<string, unknown> {
  for (const message of storedDocument()) {
    const found = (message.updateDataModel as { value?: { values?: unknown } } | undefined)?.value
      ?.values;
    if (found && typeof found === "object") return found as Record<string, unknown>;
  }
  return {};
}

beforeEach(() => {
  vi.clearAllMocks();
  createInteraction.mockResolvedValue({ id: "ix-1", draftVersion: 1 });
  upsertInteractionSurface.mockResolvedValue({ documentRef: "doc-1" });
  createThreadMessageInTransaction.mockResolvedValue({ id: "msg-1" });
  appendEventInTransaction.mockImplementation(async (_tx: unknown, event: { type: string }) =>
    event.type === "thread.surface.created" ? { seq: 7 } : { seq: 6 },
  );
});

describe("email draft publish", () => {
  it("R1: an empty body still publishes an editable card and names the gap", async () => {
    const published = await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "body", required: true, status: "missing" },
      ]),
      capability: "ready",
    });

    const kinds = componentKinds();
    // Every declared field is on the card, including the empty body.
    expect(kinds.filter((kind) => kind === "TextField")).toHaveLength(4);
    expect(kinds).toContain("Button");
    // The caller is told what is still missing rather than being handed a silent shell.
    expect(published.missingRequired).toEqual(["body"]);
  });

  it("R9: a plan whose two spellings disagree is refused, not published", async () => {
    await expect(
      publishInteractionSurface(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        plan: emailPlan([
          { name: "to", value: "alex@example.test", required: true, status: "resolved" },
          { name: "To", value: "other@example.test", required: true, status: "resolved" },
          { name: "subject", value: "s", required: true, status: "resolved" },
          { name: "body", value: "b", required: true, status: "resolved" },
        ]),
        capability: "ready",
      }),
    ).rejects.toThrow(/conflicting values for field "to"/);

    // Nothing was written: a refused plan must not leave a card behind.
    expect(upsertInteractionSurface).not.toHaveBeenCalled();
    expect(createInteraction).not.toHaveBeenCalled();
  });

  it("stores one spelling per field when the plan repeats a value under two casings", async () => {
    const published = await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "To", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "Subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "body", value: "正文", required: true, status: "resolved" },
        { name: "Body", value: "正文", required: true, status: "resolved" },
      ]),
      capability: "ready",
    });

    expect(Object.keys(storedValues()).sort()).toEqual(["body", "subject", "to"]);
    expect(published.missingRequired).toEqual([]);
    expect(componentKinds().filter((kind) => kind === "TextField")).toHaveLength(4);
  });

  it("R2: a completed draft reports no missing fields", async () => {
    const published = await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: emailPlan([
        { name: "to", value: "alex@example.test", required: true, status: "resolved" },
        { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
        { name: "body", value: "正文", required: true, status: "resolved" },
      ]),
      capability: "ready",
    });
    expect(published.missingRequired).toEqual([]);
    expect(componentKinds().filter((kind) => kind === "Button")).toHaveLength(1);
  });
});
