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
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    testID?: string;
  }) => (
    <input data-testid={testID} value={value} onChange={(e) => onChangeText?.(e.target.value)} />
  ),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={() => onPress?.()}>
      {children}
    </button>
  ),
}));

vi.mock("./i18n", () => ({
  useI18n: () => ({ t: (value: string) => value }),
}));

const block = {
  kind: "a2ui_surface",
  interactionId: "ix-1",
  surfaceId: "surf-1",
  protocolFamily: "v0_9",
  draftVersion: 1,
  intent: "email.compose",
} satisfies A2uiSurfaceBlock;

describe("native terminal card", () => {
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

  // Mobile had no notion of a replaced card: a superseded block still said `lifecycle: draft`,
  // so the sheet drew a working Send for a card the server had already replaced.
  it("never draws Send on a replaced card", () => {
    render(<A2uiNativeSurface block={{ ...block, status: "superseded" }} />);
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(host.textContent).toContain("Replaced by a newer draft");
  });

  it("offers Retry on an expired card and nothing else", () => {
    const onRetry = vi.fn();
    render(<A2uiNativeSurface block={{ ...block, status: "expired" }} onRetry={onRetry} />);
    const retry = document.querySelector('[data-testid="a2ui-surface-retry"]');
    expect(retry).toBeTruthy();
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    act(() => {
      (retry as HTMLElement).click();
    });
    expect(onRetry).toHaveBeenCalled();
  });
});
