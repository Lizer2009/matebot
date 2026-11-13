import type { InteractionPlan } from "@matebot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishInteractionSurface } from "./interaction-publish.js";

/**
 * What a calendar draft actually compiles to, through the production publish path.
 *
 * The audit found an empty card where a calendar draft should have been. One cause
 * was the compiler emitting text nodes instead of controls; another was a field set
 * that did not match the registered capability. Both are about the real compiler
 * meeting the real plan, so this drives `publishInteractionSurface` — which supplies
 * the capability's own schema — and inspects the document it stores.
 *
 * It also covers the batch case: a plan for several events carries the list beside
 * the schema's fields, and the list must reach the execute path without being drawn
 * as a text box someone would have to edit by hand.
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

const calendarPlan = (fields: InteractionPlan["fields"]): InteractionPlan => ({
  intent: "calendar.create",
  title: "Next week's schedule",
  fields,
  nextStep: "request_approval",
  riskLevel: "medium",
});

const resolved = (name: string, value: unknown): InteractionPlan["fields"][number] => ({
  name,
  value,
  required: name !== "timezone",
  status: "resolved",
});

/** The document the surface was written with. */
function storedDocument(): Array<Record<string, unknown>> {
  const input = upsertInteractionSurface.mock.calls.at(-1)?.[1] as { document: unknown[] };
  return input.document as Array<Record<string, unknown>>;
}

/** The components the surface document was written with. */
function compiledComponents(): Array<Record<string, unknown>> {
  const update = storedDocument().find((message) => "updateComponents" in message) as {
    updateComponents?: { components: Array<Record<string, unknown>> };
  };
  if (!update.updateComponents) throw new Error("no updateComponents message was stored");
  return update.updateComponents.components;
}

beforeEach(() => {
  createInteraction.mockReset().mockResolvedValue({
    id: "ix-1",
    intent: "calendar.create",
    draftVersion: 1,
    title: "Next week's schedule",
    summary: null,
  });
  upsertInteractionSurface.mockReset().mockResolvedValue({ documentRef: "a2ui:x" });
  createThreadMessageInTransaction.mockReset().mockResolvedValue({ id: "msg-1" });
  appendEventInTransaction.mockReset().mockResolvedValue({ id: "event-1", seq: 3 });
});

describe("a calendar draft compiled for the card", () => {
  it("draws a real control per schema field, with the capability's own labels", async () => {
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: calendarPlan([
        resolved("name", "Weekly sync"),
        resolved("start", "2026-11-09T09:00:00+08:00"),
        resolved("end", "2026-11-09T09:30:00+08:00"),
        resolved("timezone", "Asia/Shanghai"),
      ]),
    });

    const components = compiledComponents();
    const controls = components.filter((component) =>
      ["TextField", "DateTimeInput", "CheckBox", "ChoicePicker"].includes(
        String(component.component),
      ),
    );
    // The schema's labels, not the model's field names, and each one stated once —
    // on the control that draws it, not also as a Text above it.
    const controlLabels = controls.map((component) => String(component.label ?? ""));
    for (const label of ["Name", "Starts", "Ends", "Time zone"]) {
      expect(controlLabels).toContain(label);
    }
    const text = components
      .filter((component) => component.component === "Text")
      .map((component) => String(component.text ?? ""));
    for (const label of ["Name", "Starts", "Ends", "Time zone"]) {
      expect(text).not.toContain(label);
    }
    expect(controls.length).toBeGreaterThanOrEqual(4);
    // The date fields are date inputs, so a person is not asked to type ISO by hand.
    expect(controls.some((component) => component.component === "DateTimeInput")).toBe(true);
    // The values the plan resolved are bound, not dropped on the way to the card.
    const data = storedDocument().find((message) => "updateDataModel" in message) as
      | { updateDataModel: { value: { values?: Record<string, unknown> } } }
      | undefined;
    expect(data?.updateDataModel.value.values).toMatchObject({
      name: "Weekly sync",
      timezone: "Asia/Shanghai",
    });
  });

  it("keeps a batch list out of the controls while the schema's fields stay", async () => {
    const events = [
      { summary: "Standup", start: "2026-11-09T09:00:00+08:00" },
      { summary: "Review", start: "2026-11-10T09:00:00+08:00" },
    ];
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: calendarPlan([
        resolved("name", "Two events"),
        resolved("start", "2026-11-09T09:00:00+08:00"),
        resolved("end", "2026-11-10T10:00:00+08:00"),
        resolved("timezone", "Asia/Shanghai"),
        resolved("events", events),
      ]),
    });

    const controls = compiledComponents().filter((component) =>
      ["TextField", "DateTimeInput", "CheckBox", "ChoicePicker"].includes(
        String(component.component),
      ),
    );
    const bound = controls.map((component) =>
      String((component.value as { path?: string } | undefined)?.path ?? ""),
    );
    expect(bound.some((path) => path.includes("/events"))).toBe(false);
    // One event's dates describe none of the eight on the card, and an empty Starts/Ends
    // beside a week of events is what invited a week-long placeholder event.
    for (const field of ["name", "start", "end", "timezone"]) {
      expect(bound.some((path) => path.endsWith(`/${field}`))).toBe(false);
    }
    // The list is readable text, not a control the person has to edit.
    const list = compiledComponents().find((component) => component.id === "event-list");
    expect(list).toMatchObject({ component: "Text", text: expect.stringContaining("Standup") });
    // The action stays: the list is the draft, the button is the only way to run it.
    expect(compiledComponents().some((component) => component.component === "Button")).toBe(true);
  });

  it("draws the same card when the model sends the list as JSON text", async () => {
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: calendarPlan([
        resolved("name", "Two events"),
        resolved("start", ""),
        resolved("end", ""),
        resolved(
          "events",
          JSON.stringify([
            {
              title: "Standup",
              start: "2026-11-09T09:00:00+08:00",
              end: "2026-11-09T09:15:00+08:00",
            },
            {
              title: "Review",
              start: "2026-11-10T09:00:00+08:00",
              end: "2026-11-10T10:00:00+08:00",
            },
          ]),
        ),
      ]),
    });

    const list = compiledComponents().find((component) => component.id === "event-list");
    expect(list).toMatchObject({ component: "Text", text: expect.stringContaining("Review") });
    const controls = compiledComponents().filter((component) =>
      ["TextField", "DateTimeInput", "CheckBox", "ChoicePicker"].includes(
        String(component.component),
      ),
    );
    // Empty single-event slots do not become empty controls asking for a date the batch has.
    expect(controls).toHaveLength(0);
  });

  /**
   * A re-edited card is compiled from the server's slots, not from the model's plan.
   *
   * The person's edits live in the interaction's slots and the plan records which
   * fields they touched. A republish that compiled the plan's own values would put
   * the model's text back over what the person typed — the failure the browser run
   * caught. This drives the field writer, which is the path both the card and
   * `edit_interaction` use, and reads the document it stored.
   */
  it("republishes the person's own value after they typed it", async () => {
    const { applyInteractionFieldChange } = await import("@matebot/core");
    const plan: InteractionPlan = {
      intent: "calendar.create",
      title: "Next week's schedule",
      fields: [
        { name: "name", value: "From the model", required: true, status: "resolved" },
        { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
        { name: "end", value: "2026-11-09T09:30:00+08:00", required: true, status: "resolved" },
      ],
      nextStep: "request_approval",
      riskLevel: "medium",
    };
    const slots = {
      name: "From the model",
      start: "2026-11-09T09:00:00+08:00",
      end: "2026-11-09T09:30:00+08:00",
    };
    const changed = applyInteractionFieldChange(
      { status: "collecting", draftVersion: 1, confirmedVersion: null, plan, slots },
      {
        expectedDraftVersion: 1,
        name: "name",
        value: "What the person typed",
        // What the card's own control passes: the person is the author.
        origin: "user",
      },
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    // The slot holds the person's text, and the plan records that they wrote it.
    expect(changed.slots.name).toBe("What the person typed");
    const nameField = changed.plan.fields.find((field) => field.name === "name");
    expect(nameField).toMatchObject({ value: "What the person typed", source: "user" });

    // Publishing from that plan draws the person's text, not the model's.
    await publishInteractionSurface(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      plan: changed.plan,
    });
    const data = storedDocument().find((message) => "updateDataModel" in message) as {
      updateDataModel: { value: { values?: Record<string, unknown> } };
    };
    expect(data.updateDataModel.value.values?.name).toBe("What the person typed");
  });
});
