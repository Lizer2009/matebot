import type { InteractionPlan } from "@matebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

const publishOrAmend = vi.fn();
vi.mock("./interaction-publish.js", async () => {
  const actual = await vi.importActual<typeof import("./interaction-publish.js")>(
    "./interaction-publish.js",
  );
  return { ...actual, publishOrAmend: (...args: unknown[]) => publishOrAmend(...args) };
});

const {
  interactionPublishCapability,
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
      prisma: {
        interaction: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
      },
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
  it("adds the fields the card lets a person fill, and not the sender", () => {
    const normalized = normalizeEmailComposePlan(emailPlan);
    // `from` is deliberately absent: the mailbox is decided by the connection and shown
    // read-only, so a `from` field would be a control that does nothing.
    expect(normalized.fields.map((field) => field.name)).toEqual(["cc", "to", "subject", "body"]);
    expect(normalized.fields.find((field) => field.name === "from")).toBeUndefined();
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

  it("fills the slots the registered schema declares, not a different set", () => {
    // A draft normalised to fields the schema does not declare rendered controls
    // the card could not bind and omitted ones it needed — a calendar card with
    // `events` twice and no start, end or timezone.
    const normalized = normalizeCalendarPlan(calendarPlan);
    expect(normalized.fields.map((field) => field.name)).toEqual([
      "name",
      "start",
      "end",
      "timezone",
      "allDay",
    ]);
    expect(normalized.fields.find((field) => field.name === "start")).toMatchObject({
      required: true,
      status: "missing",
    });
  });

  it("carries a batch list through as data without turning it into a field", () => {
    const normalized = normalizeCalendarPlan({
      ...calendarPlan,
      fields: [
        ...calendarPlan.fields,
        { name: "events", value: [{ name: "A" }], required: false, status: "resolved" as const },
      ],
    });
    // The batch list still reaches the execute path...
    expect(normalized.fields.some((field) => field.name === "events")).toBe(true);
    // ...and the schema's own fields are all present beside it.
    for (const name of ["name", "start", "end", "timezone", "allDay"]) {
      expect(normalized.fields.some((field) => field.name === name)).toBe(true);
    }
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
    expect(normalizeInteractionPlan(calendarPlan).fields.map((field) => field.name)).toEqual([
      "name",
      "start",
      "end",
      "timezone",
      "allDay",
    ]);
  });
});

describe("present_interaction", () => {
  beforeEach(() => {
    publishOrAmend.mockReset();
    vi.stubEnv("FEATURE_A2UI", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips the compose card when this bot has drafts off and approval allows", async () => {
    publishOrAmend.mockResolvedValueOnce({ skipped: true, reason: "drafts_disabled" });
    const notify = vi.fn(async () => undefined);
    const ctx = {
      deps: {
        prisma: {
          interaction: { findFirst: vi.fn(async () => null) },
          connection: {
            findMany: async () => [
              {
                id: "conn-1",
                connectorId: "composio",
                provider: "gmail",
                displayName: "Gmail",
                status: "connected",
                providerRef: "acct-1",
              },
            ],
          },
          spaceSettingOverride: { findUnique: async () => null },
          userActionApprovalRule: { findMany: async () => [] },
          actionApprovalRule: { findMany: async () => [] },
        },
        events: { notify },
      },
      run: {
        id: "run-1",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        trigger: "user",
        userId: "user-1",
      },
      bot: { draftsDisabled: true },
      context: { userId: "user-1", signal: new AbortController().signal },
      notify,
    };
    const result = (await interactionTools.present_interaction!(
      ctx as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(publishOrAmend).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skippedDraft: true,
      draftsDisabled: true,
      executed: false,
      intent: "email.compose",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses the action when drafts are off and a rule denies it", async () => {
    const ctx = {
      deps: {
        prisma: {
          interaction: { findFirst: vi.fn(async () => null) },
          connection: {
            findMany: async () => [
              {
                id: "conn-1",
                connectorId: "composio",
                provider: "gmail",
                displayName: "Gmail",
                status: "connected",
                providerRef: "acct-1",
              },
            ],
          },
          spaceSettingOverride: { findUnique: async () => null },
          userActionApprovalRule: {
            findMany: async () => [
              {
                id: "rule-deny",
                effect: "deny",
                matchKind: "tool",
                matchValue: "gmail_send_email",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
              },
            ],
          },
          actionApprovalRule: { findMany: async () => [] },
        },
        events: { notify: vi.fn(async () => undefined) },
      },
      run: {
        id: "run-1",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        trigger: "user",
        userId: "user-1",
      },
      bot: { draftsDisabled: true },
      context: { userId: "user-1", signal: new AbortController().signal },
      notify: vi.fn(async () => undefined),
    };
    const result = (await interactionTools.present_interaction!(
      ctx as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(result.error).toMatch(/blocked by an approval rule/);
    expect(publishOrAmend).not.toHaveBeenCalled();
  });

  it("publishes an email.compose surface when FEATURE_A2UI is on", async () => {
    publishOrAmend.mockResolvedValueOnce({
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
    expect(publishOrAmend).toHaveBeenCalledWith(
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

  it("does not open a compose connection view when connect.gmail is already waiting (AC-26 reverse)", async () => {
    const ctx = context();
    ctx.deps.prisma.interaction.findFirst = vi.fn(async () => ({
      id: "ix-connect",
      intent: "connect.gmail",
      status: "needs_connection",
    }));
    const result = (await interactionTools.present_interaction!(
      ctx as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(publishOrAmend).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      interactionId: "ix-connect",
      status: "needs_connection",
      skippedDuplicateConnection: true,
    });
  });

  it("does not open a compose connection view when a named reconnect card is already waiting", async () => {
    const ctx = context();
    ctx.deps.prisma.interaction.findFirst = vi.fn(async () => ({
      id: "ix-ca1",
      intent: "connect.gmail.ca_1",
      status: "needs_connection",
    }));
    const result = (await interactionTools.present_interaction!(
      ctx as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(publishOrAmend).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      interactionId: "ix-ca1",
      skippedDuplicateConnection: true,
    });
  });

  it("says nothing when the surface was published without a capability stamp", async () => {
    publishOrAmend.mockResolvedValueOnce({
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
    expect(result.reply).toBe("请审阅后点发送，尚未发出。");
  });

  it("answers a calendar request with a calendar surface, not prose", async () => {
    publishOrAmend.mockResolvedValueOnce({
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
    expect(publishOrAmend).toHaveBeenCalledWith(
      ctx.deps.prisma,
      expect.objectContaining({
        plan: expect.objectContaining({
          intent: "calendar.create",
          fields: expect.arrayContaining([
            expect.objectContaining({ name: "name" }),
            expect.objectContaining({ name: "start" }),
            expect.objectContaining({ name: "end" }),
          ]),
        }),
      }),
    );
    expect(result).toMatchObject({
      intent: "calendar.create",
      capability: "ready",
      reply: "请审阅后点创建，尚未写入日历。",
    });
  });

  it("leaves the open-card decision to the kernel instead of resolving a draft locally", async () => {
    publishOrAmend.mockResolvedValueOnce({
      interactionId: "ix-2",
      surfaceId: "surface-2",
      messageId: "msg-2",
      documentRef: "a2ui:interaction:ix-2:surface:surface-2",
      draftVersion: 2,
      eventSeq: 13,
      amended: true,
      capability: "ready",
      plan: {
        intent: "calendar.create",
        title: "Trip",
        fields: [],
        nextStep: "ask",
        riskLevel: "medium",
      },
      slots: {},
      missingRequired: [],
    });
    const ctx = context();
    await interactionTools.present_interaction!(
      ctx as never,
      call({
        plan: {
          intent: "calendar.create",
          title: "Trip",
          fields: [{ name: "name", value: "Vegas", required: true, status: "resolved" }],
          nextStep: "ask",
          riskLevel: "medium",
        },
      }),
    );
    // One call decides create-or-amend; the card's own surface is the kernel's business.
    // findFirst may look up an existing connect.* view (AC-26); it must not pick the draft.
    expect(publishOrAmend).toHaveBeenCalledTimes(1);
    expect(publishOrAmend.mock.calls[0]![1]).not.toHaveProperty("amendsInteractionId");
  });

  it("refuses when FEATURE_A2UI is off", async () => {
    vi.stubEnv("FEATURE_A2UI", "0");
    const result = (await interactionTools.present_interaction!(
      context() as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;
    expect(result.error).toMatch(/not enabled/i);
    expect(publishOrAmend).not.toHaveBeenCalled();
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

describe("interactionPublishCapability", () => {
  const connectedMailbox = (displayName: string) => ({
    prisma: {
      connection: {
        findMany: async () => [
          {
            id: "conn-1",
            connectorId: "composio",
            provider: "gmail",
            displayName,
            status: "connected",
            providerRef: "acct-1",
          },
        ],
      },
    },
  });

  it("takes the sender label from the connection and never invents an address", async () => {
    // The label is the connection's own name, which the client supplied. It is not the mailbox,
    // so it goes to `label` and `address` stays undefined — the card can say "sending from" and
    // still be honest that it does not know the address.
    const ctx = {
      deps: connectedMailbox("Gmail"),
      run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      context: { userId: "user-1", signal: new AbortController().signal },
    } as never;
    const stamp = await interactionPublishCapability(ctx, { intent: "email.compose" });
    expect(stamp.capability).toBe("ready");
    expect(stamp.sender).toEqual({ label: "Gmail" });
    expect(stamp.sender?.address).toBeUndefined();
  });

  it("does not treat a label that looks like an address as one", async () => {
    const ctx = {
      deps: connectedMailbox("alex@example.test"),
      run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      context: { userId: "user-1", signal: new AbortController().signal },
    } as never;
    const stamp = await interactionPublishCapability(ctx, { intent: "email.compose" });
    expect(stamp.sender).toEqual({ label: "alex@example.test" });
    expect(stamp.sender?.address).toBeUndefined();
  });

  it("reports no connection when the person has none", async () => {
    const ctx = {
      deps: { prisma: { connection: { findMany: async () => [] } } },
      run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      context: { userId: "user-1", signal: new AbortController().signal },
    } as never;
    const stamp = await interactionPublishCapability(ctx, { intent: "email.compose" });
    expect(stamp.capability).toBe("not_connected");
    // Nothing to name: no connection, so no sender at all.
    expect(stamp.sender).toBeUndefined();
  });
});

describe("present_interaction describes the card it stored", () => {
  beforeEach(() => {
    publishOrAmend.mockReset();
    vi.stubEnv("FEATURE_A2UI", "1");
  });

  it("reports the fields, the gaps and the sender from what was published", async () => {
    // The publisher reports what it stored; the tool passes that through so the reply can be
    // written from the card instead of from the plan the model submitted.
    publishOrAmend.mockResolvedValueOnce({
      interactionId: "ix-1",
      surfaceId: "surface-1",
      messageId: "msg-1",
      documentRef: "a2ui:interaction:ix-1:surface:surface-1",
      draftVersion: 2,
      eventSeq: 9,
      capability: "ready",
      missingRequired: ["body"],
      plan: {
        intent: "email.compose",
        title: "冬天的问候",
        fields: [
          { name: "to", value: "alex@example.test", required: true, status: "resolved" },
          { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
          { name: "body", required: true, status: "missing" },
        ],
        nextStep: "render",
        riskLevel: "medium",
      },
      slots: { to: "alex@example.test", subject: "冬天的问候" },
    });
    const result = (await interactionTools.present_interaction!(
      context() as never,
      call({ plan: emailPlan }),
    )) as Record<string, unknown>;

    expect(result.missingRequired).toEqual(["body"]);
    expect(result.reply).toBe("请先补全收件人和主题。");
    expect(result.actionable).toBe(false);
    expect(result.blockedBy).toEqual(["body"]);
    expect(result.fields).toEqual([
      { name: "to", value: "alex@example.test", required: true, filled: true },
      { name: "subject", value: "冬天的问候", required: true, filled: true },
      { name: "body", value: "", required: true, filled: false },
    ]);
  });

  it("stores a resume plan when the card waits on a connection", async () => {
    publishOrAmend.mockResolvedValueOnce({
      interactionId: "ix-1",
      surfaceId: "surface-1",
      messageId: "msg-1",
      documentRef: "a2ui:interaction:ix-1:surface:surface-1",
      draftVersion: 1,
      eventSeq: 1,
      capability: "not_connected",
      missingRequired: ["subject", "body"],
      plan: emailPlan,
      slots: { to: "a@example.com" },
    });
    await interactionTools.present_interaction!(context() as never, call({ plan: emailPlan }));
    expect(publishOrAmend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "needs_connection",
        resumePlan: expect.objectContaining({
          intent: "email.compose",
          slots: expect.objectContaining({ to: "a@example.com" }),
        }),
      }),
    );
  });
});
