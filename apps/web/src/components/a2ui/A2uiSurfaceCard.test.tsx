// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2uiSurfaceCard } from "./A2uiSurfaceCard";
import { fixtureA2uiSurfaceBlock, unknownComponentSurfaceMessages } from "./fixtures";

const lingui = vi.hoisted(() => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({
    t: (input: TemplateStringsArray | { message: string }, ...values: unknown[]) => {
      if (typeof input === "object" && "message" in input) return input.message;
      return String.raw(input, ...values);
    },
    i18n: { locale: "en" },
  }),
}));
vi.mock("@lingui/react/macro", () => lingui);
vi.mock("@lingui/react", () => lingui);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.loadAndActivate({ locale: "en", messages: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderCard(
  block: A2uiSurfaceBlock,
  messages?: unknown[],
  supersededOrOptions?: boolean | { superseded?: boolean; onRetry?: () => Promise<void> },
) {
  const options =
    typeof supersededOrOptions === "boolean"
      ? { superseded: supersededOrOptions }
      : (supersededOrOptions ?? {});
  act(() =>
    root.render(
      <A2uiSurfaceCard
        block={block}
        messages={messages}
        {...(options.superseded === undefined ? {} : { superseded: options.superseded })}
        {...(options.onRetry ? { onRetry: options.onRetry } : {})}
      />,
    ),
  );
}

describe("A2uiSurfaceCard", () => {
  it("offers nothing on a replaced card, even when its document holds a button", () => {
    renderCard(fixtureA2uiSurfaceBlock({ status: "superseded", lifecycle: "draft" }));
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
    expect(container.textContent).toContain("Replaced by a newer draft");
  });

  it("offers only Retry on an expired card", () => {
    renderCard(fixtureA2uiSurfaceBlock({ status: "expired", lifecycle: "draft" }), undefined, {
      onRetry: async () => {},
    });
    expect(container.querySelector('[data-testid="a2ui-surface-retry"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("shows the category above the card's own title", () => {
    renderCard(fixtureA2uiSurfaceBlock({ title: "产品发布", intent: "email.compose" }));
    const header = container.querySelector('[data-testid="a2ui-surface-header"]')!;
    expect(header.textContent).toContain("Email");
    expect(header.textContent).toContain("产品发布");
  });

  it("treats a legacy block with no status as the draft it claims to be", () => {
    const { status: _omitted, ...legacy } = fixtureA2uiSurfaceBlock({
      lifecycle: "draft",
      documentRef: undefined,
    });
    renderCard(legacy as never);
    expect(container.querySelector('[data-testid="a2ui-surface-placeholder"]')).toBeTruthy();
  });

  it("shows a corrected draft as replaced and offers nothing to press", () => {
    // Two cards for the same event each had a working Create button, so a user could create it
    // twice, and the older button gave no sign it was stale.
    renderCard(
      fixtureA2uiSurfaceBlock({ documentRef: undefined, title: "Old draft" }),
      undefined,
      true,
    );
    expect(
      container.querySelector('[data-testid="a2ui-surface-superseded"]')?.textContent,
    ).toContain("Replaced by a newer draft");
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-surface-placeholder"]')).toBeNull();
  });

  it("shows title and placeholder without a document", () => {
    renderCard(
      fixtureA2uiSurfaceBlock({
        documentRef: undefined,
        title: "Draft",
        summary: "Waiting",
      }),
    );
    expect(container.querySelector('[data-testid="a2ui-surface-card"]')?.textContent).toContain(
      "Draft",
    );
    expect(container.querySelector('[data-testid="a2ui-surface-placeholder"]')).toBeTruthy();
  });

  it("does not render v1_0 surfaces in the Phase 1 host", () => {
    renderCard(
      fixtureA2uiSurfaceBlock({
        protocolFamily: "v1_0",
        documentRef: undefined,
      }),
    );
    expect(container.textContent).toMatch(/v1_0/);
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
  });

  it("refuses unknown catalog components without mounting a surface host", async () => {
    renderCard(
      fixtureA2uiSurfaceBlock({
        surfaceId: "fixture-unknown",
        documentRef: undefined,
      }),
      unknownComponentSurfaceMessages(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const refused = container.querySelector('[data-testid="a2ui-surface-refused"]');
    expect(refused?.textContent).toMatch(/EvilWidget/);
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
  });

  it("edits an email compose draft on the review card", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 2 }));
    const onConfirm = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      title: "Send email",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onFieldChange={onFieldChange}
          onConfirm={onConfirm}
        />,
      ),
    );
    expect(
      (container.querySelector('[data-testid="a2ui-email-to"]') as HTMLInputElement).value,
    ).toBe("a@example.com");
    expect(container.querySelector('[data-testid="a2ui-email-status"]')?.textContent).toMatch(
      /Needs approval/,
    );
    expect(container.querySelector('[data-testid="a2ui-email-confirm"]')).toBeNull();
    const subject = container.querySelector(
      '[data-testid="a2ui-email-subject"]',
    ) as HTMLInputElement;
    setControlValue(subject, "Hello again");
    await act(async () => {
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      subject.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(onFieldChange).toHaveBeenCalledWith("subject", "Hello again", 1);
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
  });

  it("sends with confirm+execute in one gesture when props omit confirmedVersion", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onConfirm={onConfirm}
          onSend={onSend}
        />,
      ),
    );
    const form = container.querySelector('[data-testid="a2ui-email-compose"]') as HTMLElement;
    expect(form.getAttribute("data-confirmed")).toBe("false");
    const send = container.querySelector('[data-testid="a2ui-email-send"]') as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    expect(onConfirm).toHaveBeenCalledWith(1);
    expect(onSend).toHaveBeenCalledWith(1);
    expect(container.querySelector('[data-testid="a2ui-email-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    expect(form.getAttribute("data-sent")).toBe("false");
  });

  it("sends without a second confirm when the draft is already confirmed", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      confirmedVersion: 1,
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onConfirm={onConfirm}
          onSend={onSend}
        />,
      ),
    );
    const send = container.querySelector('[data-testid="a2ui-email-send"]') as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(1);
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
  });

  it("does not paint Sent until the server success stamp arrives", async () => {
    let finishSend!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSend = resolve;
        }),
    );
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      confirmedVersion: 1,
      capability: "ready",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={onSend} />,
      ),
    );
    await act(async () => {
      (container.querySelector('[data-testid="a2ui-email-send"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="a2ui-email-progress"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    await act(async () => {
      finishSend();
    });
    const form = container.querySelector('[data-testid="a2ui-email-compose"]') as HTMLElement;
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    expect(form.getAttribute("data-sent")).toBe("false");
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={{
            ...block,
            template: "action-result-success",
            lifecycle: "succeeded",
            providerMessageId: "msg-1",
          }}
          messages={emailSurfaceMessages()}
        />,
      ),
    );
    expect(container.textContent).toContain("Done");
    expect(container.querySelector('[data-testid="a2ui-email-compose"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(container.textContent).not.toContain("msg-1");
  });

  it("shows a failed card without Sent when send is an internal error", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("Internal server error");
    });
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      confirmedVersion: 1,
      capability: "ready",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={onSend} />,
      ),
    );
    await act(async () => {
      (container.querySelector('[data-testid="a2ui-email-send"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-error"]')?.textContent).toMatch(
      /Internal server error/,
    );
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={{
            ...block,
            status: "failed",
            template: "action-result-failed",
            lifecycle: "failed",
            error: "Internal server error",
          }}
          messages={emailSurfaceMessages()}
          onSend={onSend}
        />,
      ),
    );
    expect(container.textContent).toContain("Failed");
    expect(container.querySelector('[data-testid="a2ui-email-compose"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("discards the review card without sending", async () => {
    const onDiscard = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onDiscard={onDiscard}
          onSend={onSend}
        />,
      ),
    );
    const discard = container.querySelector(
      '[data-testid="a2ui-email-discard"]',
    ) as HTMLButtonElement;
    await act(async () => {
      discard.click();
    });
    expect(onDiscard).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="a2ui-email-compose"]')?.textContent).toMatch(
      /Discarded/,
    );
  });

  it("shows connect and hides Send when the mailbox is not connected", () => {
    const onConnect = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "not_connected",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onConnect={onConnect}
          onSend={onSend}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-connect"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-reauth"]')).toBeNull();
  });

  it("shows reauth and hides Send when the mailbox needs reconnect", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "requires_reauth",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={vi.fn()} />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-reauth"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-connect"]')).toBeNull();
  });

  it("shows the sending account as a read-only row, never as an address", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
      senderLabel: "Gmail",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={vi.fn()} />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-sender"]')?.textContent).toBe("Gmail");
    // A missing mailbox is not announced as "not provided"; the connection name is enough.
    expect(container.querySelector('[data-testid="a2ui-email-sender-note"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Email address not provided/);
    // Read-only: the sending mailbox is not one of the form's inputs.
    expect(container.querySelector('input[aria-label="From"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-from"]')).toBeNull();
  });

  it("shows the provider mailbox when the block carries one", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
      senderLabel: "Gmail",
      senderAddress: "lizer@example.test",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={vi.fn()} />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-sender"]')?.textContent).toBe(
      "lizer@example.test",
    );
    expect(container.querySelector('[data-testid="a2ui-email-sender-note"]')).toBeNull();
  });

  it("falls back to Connected account when neither label nor address is present", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={vi.fn()} />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-sender"]')?.textContent).toBe(
      "Connected account",
    );
  });

  it("does not name a sending account on a card that is asking for one", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "not_connected",
      senderLabel: "Gmail",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onConnect={vi.fn()} />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-connect"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="a2ui-email-sender"]')).toBeNull();
  });

  it("shows Send after a successful connect", async () => {
    const onConnect = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "not_connected",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onConnect={onConnect}
          onSend={onSend}
        />,
      ),
    );
    const connect = container.querySelector(
      '[data-testid="a2ui-email-connect"]',
    ) as HTMLButtonElement;
    await act(async () => {
      connect.click();
    });
    expect(onConnect).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="a2ui-email-connect"]')).toBeNull();
  });

  it("shows a disabled progress card while the send is executing", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
      template: "action-progress-card",
      lifecycle: "executing",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={vi.fn()} />,
      ),
    );
    const form = container.querySelector('[data-testid="a2ui-email-compose"]') as HTMLElement;
    expect(form.getAttribute("data-template")).toBe("action-progress-card");
    expect(container.querySelector('[data-testid="a2ui-email-progress"]')?.textContent).toMatch(
      /Sending email/,
    );
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(
      (container.querySelector('[data-testid="a2ui-email-subject"]') as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows success without the provider message id", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
      template: "action-result-success",
      lifecycle: "succeeded",
      providerMessageId: "msg-1",
    });
    act(() => root.render(<A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} />));
    expect(container.textContent).toContain("Done");
    expect(container.querySelector('[data-testid="a2ui-email-compose"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-provider-id"]')).toBeNull();
    expect(container.textContent).not.toContain("msg-1");
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("opens Manage rules from the approval menu", async () => {
    const onManageRules = vi.fn();
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onManageRules={onManageRules}
          onSend={onSend}
        />,
      ),
    );
    const status = container.querySelector(
      '[data-testid="a2ui-email-status"]',
    ) as HTMLButtonElement;
    expect(status.textContent).toMatch(/Needs approval/);
    await act(async () => {
      status.click();
    });
    const manage = document.querySelector('[data-testid="a2ui-email-manage-rules"]') as HTMLElement;
    expect(manage).toBeTruthy();
    await act(async () => {
      manage.click();
    });
    expect(onManageRules).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeTruthy();
  });

  it("hides Manage rules when no settings opener is passed", async () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
    });
    act(() => root.render(<A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} />));
    const status = container.querySelector(
      '[data-testid="a2ui-email-status"]',
    ) as HTMLButtonElement;
    await act(async () => {
      status.click();
    });
    expect(document.querySelector('[data-testid="a2ui-email-manage-rules"]')).toBeNull();
    expect(document.querySelector('[data-testid="a2ui-email-approval-require"]')).toBeTruthy();
  });

  it("shows a failed card with Retry and no Send", async () => {
    const onRetry = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      confirmedVersion: 1,
      capability: "ready",
      status: "failed",
      template: "action-result-failed",
      lifecycle: "failed",
      error: "Could not send the email",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onSend={onSend}
          onRetry={onRetry}
        />,
      ),
    );
    expect(container.textContent).toContain("Failed");
    expect(container.querySelector('[data-testid="a2ui-email-compose"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    const retry = container.querySelector(
      '[data-testid="a2ui-surface-retry"]',
    ) as HTMLButtonElement;
    await act(async () => {
      retry.click();
    });
    expect(onRetry).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows UNKNOWN with Check status and no Send", async () => {
    const onCheckStatus = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "ready",
      template: "action-reconcile-card",
      lifecycle: "unknown",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onCheckStatus={onCheckStatus}
          onSend={onSend}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-unknown"]')?.textContent).toMatch(
      /Don't send again/,
    );
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-retry"]')).toBeNull();
    await act(async () => {
      (
        container.querySelector('[data-testid="a2ui-email-check-status"]') as HTMLButtonElement
      ).click();
    });
    expect(onCheckStatus).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  // The live failure: a dead Connector account made Send fail. The card has to
  // offer reauthorization instead of a Retry that would fail the same way.
  it("offers Reconnect instead of Retry when a send failed on a dead authorization", async () => {
    const onConnect = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "requires_reauth",
      template: "email-reauth-card",
      lifecycle: "failed",
      error: "The gmail connection is no longer active. Ask the user to reconnect gmail.",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard
          block={block}
          messages={emailSurfaceMessages()}
          onConnect={onConnect}
          onSend={onSend}
        />,
      ),
    );
    const form = container.querySelector('[data-testid="a2ui-email-compose"]') as HTMLElement;
    expect(form.getAttribute("data-template")).toBe("email-reauth-card");
    expect(container.querySelector('[data-testid="a2ui-email-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-status"]')?.textContent).toMatch(
      /Authorization expired/,
    );
    const reauth = container.querySelector(
      '[data-testid="a2ui-email-reauth"]',
    ) as HTMLButtonElement;
    await act(async () => {
      reauth.click();
    });
    expect(onConnect).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("labels an unconnected surface as not connected rather than needing approval", () => {
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      capability: "not_connected",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={vi.fn()} />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-status"]')?.textContent).toMatch(
      /Not connected/,
    );
  });
});

function emailSurfaceMessages(): unknown[] {
  return [
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "fixture-minimal",
        value: {
          intent: "email.compose",
          fields: [
            { name: "from", value: "bot@example.com" },
            { name: "to", value: "a@example.com" },
            { name: "cc", value: "" },
            { name: "subject", value: "Hi" },
            { name: "body", value: "Hello" },
          ],
        },
      },
    },
  ];
}

/**
 * A card whose document cannot be resolved must say so.
 *
 * The audit found an empty frame where a calendar card should have been, while
 * the log showed the surface had been published. The region was drawn, but with
 * nothing in it. These pin that every unresolved state renders readable content.
 */
describe("A2uiSurfaceCard when the document cannot be resolved", () => {
  const block = {
    kind: "a2ui_surface",
    interactionId: "ix-1",
    surfaceId: "surf-1",
    protocolFamily: "v0_9",
    draftVersion: 1,
    intent: "calendar.create",
    title: "Next week's schedule",
    documentRef: "a2ui:interaction:ix-1:surface:surf-1",
  } satisfies A2uiSurfaceBlock;

  it("shows a reason and a retry instead of a blank region with no fetcher", () => {
    act(() => root.render(<A2uiSurfaceCard block={block} />));
    const placeholder = container.querySelector('[data-testid="a2ui-surface-placeholder"]');
    expect(placeholder).not.toBeNull();
    // The old markup was an empty div: no text at all.
    expect((placeholder?.textContent ?? "").trim().length).toBeGreaterThan(0);
    expect(container.textContent).toContain("could not be shown");
    expect(container.textContent).toContain("Try again");
  });

  it("says it is loading while a fetch is in flight", async () => {
    let resolve: ((value: unknown[]) => void) | undefined;
    const fetchDocument = () =>
      new Promise<unknown[]>((done) => {
        resolve = done;
      });
    act(() => root.render(<A2uiSurfaceCard block={block} fetchDocument={fetchDocument} />));
    expect(container.textContent).toContain("Loading this card");
    await act(async () => {
      resolve?.([{ createSurface: { surfaceId: "surf-1" } }]);
      await Promise.resolve();
    });
  });

  it("explains a failed load and offers to load again", async () => {
    const fetchDocument = vi.fn(async () => {
      throw new Error("boom");
    });
    await act(async () => {
      root.render(<A2uiSurfaceCard block={block} fetchDocument={fetchDocument} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="a2ui-surface-placeholder-reason"]')?.textContent,
    ).toBe("boom");
    const retry = container.querySelector("button");
    expect(retry?.textContent).toContain("Try again");
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(fetchDocument.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

function setControlValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
}
