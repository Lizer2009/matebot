import type { InteractionPlan } from "@matebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

const publishInteractionSurface = vi.fn();
vi.mock("./interaction-publish.js", () => ({
  publishInteractionSurface: (...args: unknown[]) => publishInteractionSurface(...args),
}));

const { interactionTools, normalizeEmailComposePlan } = await import("./run-tools-interaction.js");
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
      }),
    );
    expect(result).toMatchObject({
      interactionId: "ix-1",
      surfaceId: "surface-1",
      messageId: "msg-1",
      intent: "email.compose",
    });
    expect(ctx.notify).toHaveBeenCalledWith("thread-1", 9);
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
    expect(tool?.description).toMatch(/any language/);
    expect(tool?.description).toContain("email.compose");
    expect(tool?.description).toMatch(
      /Never send mail with shell, python, smtplib, or request_secret/,
    );
    expect(tool?.description).not.toMatch(/SMTP/);
    expect(tool?.description).not.toMatch(/request_secret as usual/);
  });
});
