// @vitest-environment jsdom

import type { A2uiSurfaceBlock } from "@matebot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2uiNativeSurface } from "../components/thread/a2ui-native-surface";

vi.mock("react-native", () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <span data-testid={testID}>{children}</span>
  ),
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  TextInput: ({
    value,
    onChangeText,
    testID,
    accessibilityLabel,
  }: {
    value?: string;
    testID?: string;
    accessibilityLabel?: string;
    onChangeText?: (value: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      data-testid={testID}
      value={value}
      onChange={(event) => onChangeText?.(event.target.value)}
    />
  ),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    testID?: string;
    onPress?: () => void;
  }) => (
    <button type="button" data-testid={testID} onClick={() => onPress?.()}>
      {children}
    </button>
  ),
}));

const block = {
  kind: "a2ui_surface",
  interactionId: "ix-1",
  surfaceId: "surf-1",
  protocolFamily: "v0_9",
  draftVersion: 1,
  intent: "email.compose",
} satisfies A2uiSurfaceBlock;

function text(id: string): string {
  return document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
}

function click(id: string) {
  const node = document.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${id}`);
  node.click();
}

function type(id: string, value: string) {
  const node = document.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("native A2UI surface", () => {
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  function render(node: ReactNode) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(node));
  }

  it("rejects send until the draft is confirmed", async () => {
    const onSend = vi.fn();
    render(<A2uiNativeSurface block={block} onSend={onSend} />);
    await act(async () => {
      click("a2ui-email-send");
    });
    expect(text("a2ui-email-error")).toBe("Confirm this draft before sending.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends a draft that is already confirmed", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<A2uiNativeSurface block={{ ...block, confirmedVersion: 1 }} onSend={onSend} />);
    await act(async () => {
      click("a2ui-email-send");
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledOnce();
    expect(text("a2ui-email-sent")).toBe("Sent");
  });

  it("commits edited fields before confirm", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 2 }));
    const onConfirm = vi.fn(async () => undefined);
    render(<A2uiNativeSurface block={block} onFieldChange={onFieldChange} onConfirm={onConfirm} />);
    await act(async () => {
      type("a2ui-email-subject", "Hello again");
    });
    await act(async () => {
      click("a2ui-email-confirm");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onFieldChange).toHaveBeenCalledWith("subject", "Hello again", 1);
    expect(onConfirm).toHaveBeenCalledWith(2);
  });

  it("shows the catalog and refuses an unknown component", () => {
    const messages = [
      {
        updateComponents: {
          components: [
            { id: "sheet", component: "Sheet", label: "More", children: ["title", "field", "go"] },
            { id: "title", component: "Text", text: "Hello" },
            { id: "field", component: "TextField", label: "Note", value: "Body" },
            { id: "go", component: "Button", text: "Go" },
          ],
        },
      },
    ];
    const plain = { ...block, intent: undefined };
    render(<A2uiNativeSurface block={plain} messages={messages} />);
    expect(
      document.querySelector('[data-testid="a2ui-native-field-field"]')?.getAttribute("aria-label"),
    ).toBe("Note");
    expect(text("a2ui-native-button-go")).toBe("Go");
    expect(host.textContent).toContain("Hello");
    expect(document.querySelector('[data-testid="a2ui-native-sheet"]')).not.toBeNull();

    act(() =>
      root.render(
        <A2uiNativeSurface
          block={plain}
          messages={[
            { updateComponents: { components: [{ id: "bad", component: "EvilWidget" }] } },
          ]}
        />,
      ),
    );
    expect(text("a2ui-native-refused")).toBe("EvilWidget");
  });
});
