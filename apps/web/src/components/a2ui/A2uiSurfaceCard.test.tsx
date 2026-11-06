// @vitest-environment jsdom
import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2uiSurfaceCard } from "./A2uiSurfaceCard";
import { fixtureA2uiSurfaceBlock, unknownComponentSurfaceMessages } from "./fixtures";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

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

  it("edits and confirms an email compose draft", async () => {
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
    const confirm = container.querySelector(
      '[data-testid="a2ui-email-confirm"]',
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
    });
    expect(onConfirm).toHaveBeenCalledWith(2);
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
  });

  it("rejects send until the draft version is confirmed", async () => {
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
          onConfirm={async () => undefined}
          onSend={onSend}
        />,
      ),
    );
    const send = container.querySelector('[data-testid="a2ui-email-send"]') as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="a2ui-email-error"]')?.textContent).toMatch(
      /Confirm this draft/,
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
            { name: "to", value: "a@example.com" },
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
