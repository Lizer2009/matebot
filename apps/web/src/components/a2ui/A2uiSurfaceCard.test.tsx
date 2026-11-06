// @vitest-environment jsdom
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderCard(block: A2uiSurfaceBlock, messages?: unknown[]) {
  act(() => root.render(<A2uiSurfaceCard block={block} messages={messages} />));
}

describe("A2uiSurfaceCard", () => {
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
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')?.textContent).toMatch(/Sent/);
    expect(
      (container.querySelector('[data-testid="a2ui-email-compose"]') as HTMLElement).getAttribute(
        "data-sent",
      ),
    ).toBe("true");
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
            template: "action-result-failed",
            lifecycle: "failed",
            error: "Internal server error",
          }}
          messages={emailSurfaceMessages()}
          onSend={onSend}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-failed"]')?.textContent).toMatch(
      /Internal server error/,
    );
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
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
      /Sending/,
    );
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(
      (container.querySelector('[data-testid="a2ui-email-subject"]') as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows success with the provider message id on the same surface", () => {
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
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')?.textContent).toMatch(/Sent/);
    expect(container.querySelector('[data-testid="a2ui-email-provider-id"]')?.textContent).toBe(
      "msg-1",
    );
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("shows a failed card with Retry and no Send", async () => {
    const onSend = vi.fn(async () => undefined);
    const block = fixtureA2uiSurfaceBlock({
      intent: "email.compose",
      documentRef: undefined,
      draftVersion: 1,
      confirmedVersion: 1,
      capability: "ready",
      template: "action-result-failed",
      lifecycle: "failed",
      error: "Could not send the email",
    });
    act(() =>
      root.render(
        <A2uiSurfaceCard block={block} messages={emailSurfaceMessages()} onSend={onSend} />,
      ),
    );
    expect(container.querySelector('[data-testid="a2ui-email-failed"]')?.textContent).toMatch(
      /Could not send the email/,
    );
    expect(container.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    const retry = container.querySelector('[data-testid="a2ui-email-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
    });
    expect(onSend).toHaveBeenCalledWith(1);
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

function setControlValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
}
