import type { InteractionPlan } from "@matebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

const publishInteractionSurface = vi.fn();
vi.mock("./interaction-publish.js", () => ({
  publishInteractionSurface: (...args: unknown[]) => publishInteractionSurface(...args),
}));

const {
  interactionTools,
  normalizeCalendarPlan,
  normalizeEmailComposePlan,
  normalizeInteractionPlan,
} = await import("./run-tools-interaction.js");
const { isEmailShellEscape, preferredToolForEmailIntent, selectBuiltinToolsForRun } = await import(
  "./run-tool-selection.js"
);

const emailPlan: InteractionPlan = {
  intent: "email.compose",
  title: "Send email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved" },
    { name: "subject", required: true, status: "missing" },
  ],
  nextStep: "ask",
  riskLevel: "medium",
};

function context() {
  const notify = vi.fn(async () => undefined);
  return {
    deps: {
      prisma: {},
      events: { notify },
    },
    run: {
      id: "run-1",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      trigger: "user",
    },
    notify,
  };
}

const call = (args: Record<string, unknown>) =>
  ({ args, finish: (result: unknown) => result }) as never;

const toolSelectBase = {
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  messagingChannelRun: false,
};

describe("normalizeEmailComposePlan", () => {
  it("adds missing from/cc/to/subject/body for email.compose", () => {
    const normalized = normalizeEmailComposePlan(emailPlan);
    expect(normalized.fields.map((field) => field.name)).toEqual([
      "from",
      "cc",
      "to",
      "subject",
      "body",
    ]);
    expect(normalized.fields.find((field) => field.name === "from")).toMatchObject({
      required: false,
      status: "missing",
    });
    expect(normalized.fields.find((field) => field.name === "body")).toMatchObject({
      required: true,
      status: "missing",
    });
  });
});

describe("normalizeCalendarPlan", () => {
  const calendarPlan: InteractionPlan = {
    intent: "calendar.create",
    title: "Create calendar",
    fields: [{ name: "name", value: "Trips", required: true, status: "resolved" }],
    nextStep: "ask",
    riskLevel: "medium",
  };

  it("adds the optional events field so the surface can collect entries", () => {
    const normalized = normalizeCalendarPlan(calendarPlan);
    expect(normalized.fields.map((field) => field.name)).toEqual(["name", "events"]);
    expect(normalized.fields.find((field) => field.name === "events")).toMatchObject({
      required: false,
      status: "missing",
    });
  });

  it("keeps a resolved name and leaves other intents untouched", () => {
    expect(normalizeCalendarPlan(calendarPlan).fields[0]).toMatchObject({
      value: "Trips",
      status: "resolved",
    });
    expect(normalizeCalendarPlan(emailPlan)).toBe(emailPlan);
  });

  it("normalizes either app through one entry point", () => {
    expect(normalizeInteractionPlan(emailPlan).fields.map((field) => field.name)).toContain("to");
    expect(
      normalizeInteractionPlan(calendarPlan).fields.map((field) => field.name),
    ).toEqual(["name", "events"]);
  });
});

describe("present_interaction", () => {
  beforeEach(() => {
    publishInteractionSurface.mockReset();
    vi.stubEnv("FEATURE_A2UI", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("publishes an email.compose surface when FEATURE_A2UI is on", async () => {
    publishInteractionSurface.mockResolvedValueOnce({
      interactionId: "ix-1",
      surfaceId: "surface-1",
      messageId: "msg-1",
      documentRef: "a2ui:interaction:ix-1:surface:surface-1",
      draftVersion: 1,
      eventSeq: 9,
      capability: "not_connected",
    });
    const ctx = context();
    const result = (await interactionTools.present_interaction!(
      ctx as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(publishInteractionSurface).toHaveBeenCalledWith(
      ctx.deps.prisma,
      expect.objectContaining({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        plan: expect.objectContaining({ intent: "email.compose" }),
        capability: "not_connected",
        status: "needs_connection",
      }),
    );
    expect(result).toMatchObject({
      interactionId: "ix-1",
      surfaceId: "surface-1",
      messageId: "msg-1",
      intent: "email.compose",
      // The turn's only words: the card already shows the fields.
      reply: "授权完成后点卡片继续。",
    });
    expect(ctx.notify).toHaveBeenCalledWith("thread-1", 9);
  });

  it("says nothing when the surface was published without a capability stamp", async () => {
    publishInteractionSurface.mockResolvedValueOnce({
      interactionId: "ix-2",
      surfaceId: "surface-2",
      messageId: "msg-2",
      documentRef: "a2ui:interaction:ix-2:surface:surface-2",
      draftVersion: 1,
      eventSeq: 10,
    });
    const result = (await interactionTools.present_interaction!(
      context() as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(result).not.toHaveProperty("capability");
    expect(result.reply).toBe("请在卡片上确认或编辑。");
  });

  it("answers a calendar request with a calendar surface, not prose", async () => {
    publishInteractionSurface.mockResolvedValueOnce({
      interactionId: "ix-cal",
      surfaceId: "surface-cal",
      messageId: "msg-cal",
      documentRef: "a2ui:interaction:ix-cal:surface:surface-cal",
      draftVersion: 1,
      eventSeq: 12,
      capability: "ready",
    });
    const ctx = context();
    const result = (await interactionTools.present_interaction!(
      ctx as never,
      call({
        plan: {
          intent: "calendar.create",
          title: "Create calendar",
          fields: [{ name: "name", required: true, status: "missing" }],
          nextStep: "ask",
          riskLevel: "medium",
        },
      }),
    )) as Record<string, unknown>;
    expect(publishInteractionSurface).toHaveBeenCalledWith(
      ctx.deps.prisma,
      expect.objectContaining({
        plan: expect.objectContaining({
          intent: "calendar.create",
          fields: expect.arrayContaining([
            expect.objectContaining({ name: "name" }),
            expect.objectContaining({ name: "events" }),
          ]),
        }),
      }),
    );
    expect(result).toMatchObject({
      intent: "calendar.create",
      capability: "ready",
      reply: "请在卡片上确认或编辑。",
    });
  });

  it("refuses when FEATURE_A2UI is off", async () => {
    vi.stubEnv("FEATURE_A2UI", "0");
    const result = (await interactionTools.present_interaction!(
      context() as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(result.error).toMatch(/not enabled/i);
    expect(publishInteractionSurface).not.toHaveBeenCalled();
  });
});

describe("selectBuiltinToolsForRun a2ui gate", () => {
  it("offers present_interaction only when a2ui is enabled", () => {
    const off = selectBuiltinToolsForRun({ ...toolSelectBase, a2uiEnabled: false }).map(
      (tool) => tool.name,
    );
    const on = selectBuiltinToolsForRun({ ...toolSelectBase, a2uiEnabled: true }).map(
      (tool) => tool.name,
    );
    expect(off).not.toContain("present_interaction");
    expect(on).toContain("present_interaction");
  });

  it("routes email.compose/send to present_interaction over shell when A2UI tools are offered", () => {
    const on = selectBuiltinToolsForRun({ ...toolSelectBase, a2uiEnabled: true }).map(
      (tool) => tool.name,
    );
    const off = selectBuiltinToolsForRun({ ...toolSelectBase, a2uiEnabled: false }).map(
      (tool) => tool.name,
    );
    expect(on).toContain("shell");
    expect(preferredToolForEmailIntent("email.compose", on)).toBe("present_interaction");
    expect(preferredToolForEmailIntent("email.send", on)).toBe("present_interaction");
    expect(isEmailShellEscape("shell", "email.compose", on)).toBe(true);
    expect(isEmailShellEscape("user_computer_shell", "email.send", on)).toBe(true);
    expect(isEmailShellEscape("present_interaction", "email.compose", on)).toBe(false);
    expect(preferredToolForEmailIntent("email.compose", off)).toBeUndefined();
    expect(isEmailShellEscape("shell", "email.compose", off)).toBe(false);
    expect(preferredToolForEmailIntent("web.search", on)).toBeUndefined();
  });

  it("does not teach SMTP or request_secret as the mail fallback", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "present_interaction");
    expect(tool?.description).toMatch(/natural language/);
    expect(tool?.description).toContain("email.compose");
    expect(tool?.description).toContain("calendar.create");
    expect(tool?.description).toMatch(/Never send mail .* request_secret/);
    expect(tool?.description).not.toMatch(/SMTP/);
    expect(tool?.description).not.toMatch(/request_secret as usual/);
  });

  it("keeps the reply after a published surface to one short sentence", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "present_interaction");
    expect(tool?.description).toMatch(/one short sentence/);
    expect(tool?.description).toMatch(/do not restate fields/);
    expect(tool?.description).toMatch(/explain credentials/);
  });
});
